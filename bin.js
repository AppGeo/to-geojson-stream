#!/usr/bin/env node
'use strict';
var toStream = require('./')();
var JSONStream = require('jsonstream3');

toStream.stream()
  .pipe(JSONStream.stringify('{"type": "FeatureCollection","features":[', ',', ']}'))
  .pipe(process.stdout);
