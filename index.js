'use strict';
require('colors');
var fs = require('fs');
var path = require('path');
var JsonStream = require('jsonstream3');
var csv = require('csv-parser');
var stream = require('readable-stream');
var Transform = stream.Transform;
var PassThrough = stream.PassThrough;
var shapefile = require('shp-stream').reader;
var yauzl = require('yauzl');
var Proj4Geojson = require('proj4geojson');
var Kml = require('kml-stream');
var wkx = require('wkx');
var easyTypes = ['.geojson', '.kml', '.csv', '.json'];
var allTypes = easyTypes.concat('.shp');
var debug = require('debug')('to-geojson-stream');
module.exports = function () {

  var shpnameResolve, shpnameReject;
  var filename = new Promise(function (yes, no) {
    shpnameResolve = yes;
    shpnameReject = no;
  });
  var stream;
  var argv = getArgv();
  var createStream = makeStream.bind(null, argv, shpnameResolve, shpnameReject);
  return {
    stream: function() {
      if (!stream) {
        stream = createStream();
      }
      return stream;
    },
    get filename() {
      if (!stream) {
        stream = createStream();
      }
      return filename;
    },
    args: argv
  };
};
function getArgv() {
  return require('yargs')
    .alias('f', 'file')
    .describe('f', 'specify file to upload'.yellow)
    .alias('n', 'name')
    .describe('n', 'upload from stdin as file'.yellow).alias('u', 'user')
    .help('h', 'Show Help'.yellow)
    .alias('h', 'help');
}
function makeStream(args, shpnameResolve, shpnameReject) {
  var argv = args.argv;
  if (!argv.f && !argv.n && !argv._[0]) {
    process.stdout.write('name or file is required'.red);
    process.stdout.write('\n');
    process.exit(4); // eslint-disable-line no-process-exit
  }

  var fileName = argv.f || argv._[0];
  var name;
  if (fileName) {
    fileName = path.resolve(fileName);
    name = path.basename(fileName);
  }

  if (argv.n) {
    name = argv.n;
    if (!fileName) {
      var ext = path.extname(name);
      if (ext === '.shp' || ext === '.zip' || ext === '.kmz') {
        process.stdout.write(('must use full path with ' + ext).red);
        process.stdout.write('\n');
        process.exit(12);// eslint-disable-line no-process-exit
      }
    }
  }
  var tempFilename = path.basename(argv.n || argv._[0] || argv.f);
  if (path.extname(tempFilename) !== '.zip') {
    shpnameResolve(tempFilename);
  }
  return getMiddleStream(fileName || name);

  function toGeoJson() {
    return new Transform({
      objectMode: true,
      transform: function (chunk, _, next) {
        var out = {
          type: 'Feature',
          properties: chunk,
          geometry: null
        };
        if (typeof chunk.lat === 'number' && (typeof chunk.lon === 'number' || typeof chunk.lng === 'number')) {
          out.geometry = {
            type: 'point',
            coordinates: [chunk.lat, chunk.lon || chunk.lng]
          };
        } else if (typeof chunk.x === 'number' && typeof chunk.y === 'number') {
          out.geometry = {
            type: 'point',
            coordinates: [chunk.x, chunk.y]
          };
        } else if (chunk.the_geom && chunk.the_geom_webmercator) {
          // probably from carto
          try {
            out.geometry = wkx.Geometry.parse(Buffer.from(chunk.the_geom, 'hex')).toGeoJSON();
          } catch (e) {
            debug(e);
          }
        }
        this.push(out);
        next();
      }
    });
  }
  function getStream(thing) {
    if (thing) {
      return thing;
    }
    if (fileName) {
      return fs.createReadStream(fileName);
    }
    return process.stdin;
  }
  function unzipKmz() {
    var out = new PassThrough();
    yauzl.open(fileName, {autoClose: false}, function (err, zipfile){
      if (err) {
        return out.emit('error', err);
      }
      zipfile.on('entry', function (entry) {
        if (/\.kml$/.test(entry.fileName)) {
          zipfile.openReadStream(entry, function (err, readStream) {
            if (err) {
              return out.emit('error', err);
            }
            readStream.pipe(out);
          });
        }
      });
    });
    return out;
  }
  function unzipZip() {
    var out = new PassThrough({
      objectMode: true
    });
    yauzl.open(fileName, {autoClose: false}, function (err, zipfile){
      if (err) {
        return out.emit('error', err);
      }
      var files = new Map();
      zipfile.on('entry', function (entry) {
        if (/\/$/.test(entry.fileName) || /^__MACOSX/.test(entry.fileName)) {
          // directory file names end with '/'
          return;
        }
        files.set(entry.fileName, entry);
      });
      zipfile.on('end', function () {
        finishUp(files, out, zipfile);
      });
    });
    return out;
  }
  function toArray(thing) {
    var out = [];
    for (let value of thing) {
      out.push(value);
    }
    return out;
  }

  function finishUp(files, out, zipfile) {
    var keys = toArray(files.keys());
    var primary;
    if (argv.n) {
      let re = new RegExp(argv.n.replace(/\./g, '\\.') + '$');
      primary = keys.filter(function (item) {
        return item.toLowerCase().match(re);
      })[0];
    }
    if (!primary) {
      primary = keys.filter(function (item) {
        return allTypes.indexOf(path.extname(item) > -1);
      })[0];
    }
    if (!primary) {
      shpnameReject(new Error('name not found'));
      zipfile.close();
      process.stdout.write('\nnot valid file inside zip'.red);
      process.stdout.write('\n');
      process.exit(15); // eslint-disable-line no-process-exit
    }
    shpnameResolve(primary);
    var ext = path.extname(primary);
    if (easyTypes.indexOf(ext) > -1) {
      return zipfile.openReadStream(files.get(primary), function (err, stream) {
        if (err) {
          return out.emit('error', err);
        }
        getMiddleStream(primary, stream).pipe(out);
        zipfile.close();
      });
    }
    if (ext !== '.shp') {
      zipfile.close();
      process.stdout.write(('\ninvalid type ' + ext).red);
      process.stdout.write('\n');
      process.exit(16); // eslint-disable-line no-process-exit
    }
    getShapeBits(primary, files, zipfile, function (err, res) {
      if (err) {
        return out.emit('error', err);
      }
      var shpStream = shapefile({
        shp: res.shp,
        dbf: res.dbf
      }).createReadStream();
      if (res.prj) {
        shpStream.pipe(transformStream(res.prj, true)).pipe(out);
      } else {
        shpStream.pipe(out);
      }
      zipfile.close();
    });
  }
  function getShapeBits(primary, files, zipfile, cb) {
    var done = 0;
    var out = {};
    var e;
    var base = path.join(path.dirname(primary), path.basename(primary, '.shp'));
    if (files.has(base + '.prj')) {
      zipfile.openReadStream(files.get(base + '.prj'), function (err, stream) {
        if (e) {
          return;
        }
        if (err) {
          cb(err);
          e = true;
          return;
        }
        var prj = '';
        stream.on('data', function (d) {
          prj += d.toString();
        }).on('end', function () {
          if (e) {
            return;
          }
          out.prj = prj;
          done++;
          maybeFinish();
        });
      });
    } else {
      done++;
    }
    if (files.has(base + '.dbf')) {
      zipfile.openReadStream(files.get(base + '.dbf'), function (err, stream) {
        if (e) {
          return;
        }
        if (err) {
          cb(err);
          e = true;
          return;
        }
        out.dbf = stream;
        done++;
        maybeFinish();
      });
    } else {
      e = new Error('must include dbf');
      return cb(e);
    }
    zipfile.openReadStream(files.get(primary), function (err, stream) {
      if (e) {
        return;
      }
      if (err) {
        cb(err);
        e = true;
        return;
      }
      out.shp = stream;
      done++;
      maybeFinish();
    });
    function maybeFinish() {
      if (done === 3 && !e) {
        cb(null, out);
      }
    }
  }
  function getMiddleStream(name, thing) {
    var ext = path.extname(name);
    switch(ext) {
      case '.geojson':
        return getStream(thing).pipe(JsonStream.parse('features.*'));
      case '.kml':
        return getStream(thing).pipe(new Kml());
      case '.kmz':
        return unzipKmz().pipe(new Kml());
      case '.csv':
        return getStream(thing).pipe(csv()).pipe(toGeoJson());
      case '.json':
        return getStream(thing).pipe(JsonStream.parse('*')).pipe(toGeoJson());
      case '.shp':
        var dbf = path.join(path.dirname(name), path.basename(name, '.shp') + '.dbf');
        return shapefile({
          shp: fileName,
          dbf: dbf
        }).createReadStream().pipe(transformStream(path.join(path.dirname(name), path.basename(name, '.shp') + '.prj')));
      case '.zip':
        return unzipZip();
      default:
        process.stdout.write(('\nunknown file type: ' + ext).red);
        process.stdout.write('\n');
        process.exit(9);// eslint-disable-line no-process-exit
    }
  }
  function makeObject(path, noFile) {
    if (noFile) {
      return Promise.resolve(new Proj4Geojson(path));
    }
    return new Promise(function (yes) {
      fs.readFile(path, {encoding: 'utf8'}, function (err, file) {
        if (err) {
          return yes({
            feature: function (thing) {
              return thing;
            }
          });
        }
        yes(new Proj4Geojson(file));
      });
    });
  }
  function transformStream(path, noFile) {
    var obj = makeObject(path, noFile);
    return new Transform({
      objectMode: true,
      transform: function (chunk, _, next) {
        var self = this;
        if (!chunk.geometry) {
          this.push(chunk);
          return next();
        }
        obj.then(function (transformer) {
          self.push(transformer.feature(chunk));
          next();
        }).catch(next);
      }
    });
  }
}
