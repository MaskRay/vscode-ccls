#!/usr/bin/env python

import subprocess
import sys

if __name__ == "__main__":
  OUT = 'out/cquery.vsix'
  VSCE = 'node_modules/.bin/' + ('vsce.cmd' if sys.platform == 'win32' else 'vsce')
  sys.exit(subprocess.call([VSCE, 'package', '-o', OUT]))
