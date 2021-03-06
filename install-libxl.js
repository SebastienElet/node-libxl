/**
 * The MIT License (MIT)
 * 
 * Copyright (c) 2013 Christian Speckner <cnspeckn@googlemail.com>,
 *                    Torben Fitschen <teddyttn@gmail.com>
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */

var fs = require('fs'),
    Ftp = require('ftp'),
    os = require('os'),
    path = require('path'),
    tmp = require('tmp'),
    util = require('util'),
    md5 = require('md5'),
    zlib = require('zlib'),
    tar = require('tar');
    AdmZip = require('adm-zip');

var isWin = !!os.platform().match(/^win/),
    isMac = !!os.platform().match(/^darwin/),
    dependencyDir = 'deps',
    libxlDir = path.join(dependencyDir, 'libxl'),
    ftpHost = 'libxl.com',
    archiveEnv = 'NODE_LIBXL_SDK_ARCHIVE';

var download = function(callback) {
    var ftpClient = new Ftp(),
        downloadComplete = false;

    function decodeDirectoryEntry(entry) {
        var match = entry.name.match(/^libxl-(\w+)-([\d\.]+)\.([a-zA-z\.]+)$/);
        if (match) {
            return {
                file: entry.name,
                system: match[1],
                version: match[2],
                suffix: match[3]
            };
        }
    }

    function decodeVersion(file) {
        return file.version.split('.');
    }

    function compareFiles(file1, file2) {
        function cmp(a, b) {
            if (a > b) return -1;
            if (a < b) return  1;
            return 0;
        }

        var v1 = decodeVersion(file1), v2 = decodeVersion(file2),
            nibbles = Math.min(v1.length, v2.length),
            partialResult;

        for (var i = 0; i < nibbles; i++) {
            partialResult = cmp(v1[i], v2[i]);

            if (partialResult) return partialResult;
        }

        return v1.length > nibbles ? -1 : 1;
    }

    function validArchive(file) {
        if (!file) return false;

        if (isWin) {
            return file.system === "win" && file.suffix === "zip";
        } else if (isMac) {
            return file.system === "mac" && file.suffix === "tar.gz";
        }
        return file.system === "lin" && file.suffix === "tar.gz";
    }

    function onError(error) {
        if (downloadComplete) {
            console.log('WARNING: late FTP error: ' + error.message);
        } else {
            console.log('Download from FTP failed');
            throw(error);
        }
    }

    function onReady() {
        console.log('Connected, receiving directory list...');

        ftpClient.list(function(error, list) {
            if (error) onError(error);

            processDirectoryList(list);
        });
    }

    function processDirectoryList(list) {
        try {
            if (!list) throw new Error('FTP list failed');

            var candidates = list
                .map(decodeDirectoryEntry)
                .filter(validArchive)
                .sort(compareFiles);

            if (!candidates.length) throw new Error('Failed to identify a suitable download');

            download(candidates[0].file);
        } catch (error) {
            console.log(error.message);
        }
    }

    /*
     * There is a obscure bug concerning ftp.get and stream.pipe, leading to
     * occasional gobbled chunks at the end of the download
     *
     * https://github.com/mscdex/node-ftp/issues/70
     *
     * Thus, we handle the download manually and compute MD5 and total size to
     * get meaningful debug output.
     */
    function consumeDownload(instream, outstream, callback) {
        var chunks = [],
            instreamTerminated = false,
            outstreamTerminated = false,
            buffering = false,
            chunkIdx = 0,
            totalSize = 0;

        function write() {
            return outstream.write(chunks[chunkIdx++]);
        }

        function terminateOutstream() {
            if (!outstreamTerminated) outstream.end();
            outstreamTerminated = true;
        }

        instream.on('data', function(chunk) {
            chunks.push(chunk);
            totalSize += chunk.length;
            if (!buffering) buffering = !write();
        });

        instream.on('end', function() {
            instreamTerminated = true;
            if (!buffering) terminateOutstream();
        });

        outstream.on('drain', function() {
            // Write chunks until the queue is empty or the the writer get
            // overwhelmed.
            while ((buffering = chunkIdx < chunks.length) && write());

            // Stop buffering if all chunks have been flushed.
            if (!buffering && instreamTerminated) terminateOutstream();
        });

        outstream.on('close', function() {
            callback(undefined, totalSize, md5(Buffer.concat(chunks), totalSize));
        });
    }

    function download(name) {
        console.log('Downloading ' + name + '...');

        tmp.tmpName({
            postfix: path.basename(name),
            tries: 10
        }, function(err, outfile) {
            if (err) throw err;

            var writer = fs.createWriteStream(outfile);
            writer.on('error', onError);

            function onOpen() {
                ftpClient.get(name, function(error, stream) {
                    if (error) throw error;

                    stream.on('error', onError);
                    consumeDownload(stream, writer, function(err, bytes, hash) {
                        if (err) throw err;

                        ftpClient.end();
                        downloadComplete = true;

                        console.log(util.format('Download complete - %s bytes, MD5: %s',
                            bytes, hash));
                        callback(outfile);
                    });
                });
            }

            writer.on('open', onOpen);
        });        
    }

    ftpClient.on('error', onError);
    ftpClient.on('ready', onReady);

    console.log('Connecting to ftp://' + ftpHost + '...');

    ftpClient.connect({
        host: ftpHost
    });
};

var downloadIfNecessary = function(callback) {
    var suppliedArchive = process.env[archiveEnv];

    if (suppliedArchive) {
        console.log(util.format('Automatic download overriden by %s, using archive "%s"...',
            archiveEnv, suppliedArchive
        ));
        callback(suppliedArchive);
    } else {
        download(callback);
    }
};

var extractor = function(file, target, callback) {
    console.log('Extracting ' + file + ' ...');

    if (file.match(/\.zip$/)) {
        extractZip(file, target, callback);
    } else if (file.match(/\.tar\.gz/)) {
        extractTgz(file, target, callback);
    } else {
        callback(new Error('unnown archive format'));
    }
};

var extractTgz = function(archive, destination, callback) {
    var fileStream = fs.createReadStream(archive),
        decompressedStream = fileStream.pipe(zlib.createGunzip()),
        untarStream = tar.Extract({path: destination});

    untarStream.on('end', function() {
        callback();
    });
    
    [fileStream, decompressedStream, untarStream].forEach(function(stream) {
        stream.on('error', function(e) {
         callback(e);
        });
    });

    decompressedStream.pipe(untarStream);
};

var extractZip = function(archive, destination, callback) {
    var zip;

    try {
        zip = new AdmZip(archive);
        zip.extractAllTo(destination);

        callback();
    } catch (e) {
        callback(e);
    }
};

var finder = function(dir, pattern) {
  var files = fs.readdirSync(dir),
      i,
      file;
    for (i = 0; i < files.length; i++) {
        file = files[i];
        if (file.match(pattern)) {
            return path.join(dir, file);
        }
    }
    return null;
};

if (fs.existsSync(libxlDir)) {
    console.log('Libxl already downloaded, nothing to do');
    process.exit(0);
}

if (!fs.existsSync(dependencyDir)) {
    fs.mkdirSync(dependencyDir);
}

downloadIfNecessary(function(archive) {
    extractor(archive, dependencyDir, function(e) {
        if (e) {
            console.error(e.message || 'Extraction failed');
            process.exit(1);
        }

        if (!process.env[archiveEnv]) fs.unlinkSync(archive);

        var extractedDir = finder(dependencyDir, /^libxl/);
        console.log('Renaming ' + extractedDir + ' to ' + libxlDir + ' ...');

        fs.renameSync(extractedDir, libxlDir);

        console.log('All done!');
    });
});
