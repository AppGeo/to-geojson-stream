#!/bin/bash

set -e

./bin.js -n foo.csv < test/b.csv | geojsonhint

./bin.js -f test/b.csv | geojsonhint

./bin.js -f test/a.csv | geojsonhint

./bin.js -f test/test.zip | geojsonhint

./bin.js -f test/test.zip -n b.csv | geojsonhint

A="$(./bin.js -f test/test.zip)"
B="$(./bin.js -f test/test.zip -n b.csv)"

if [[ "$A" = "$B" ]]
then
  echo fail
  exit 1
else
  echo success
  exit 0
fi
