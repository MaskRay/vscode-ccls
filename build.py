#!/usr/bin/env python

import subprocess
import sys
from os.path import join

if __name__ == "__main__":
  OUT = 'out/ccls.vsix'
  VSCE = 'vsce.cmd' if sys.platform == 'win32' else 'vsce'
  VSCE = join('node_modules', '.bin', VSCE)
  sys.exit(subprocess.call([VSCE, 'package', '-o', OUT]))
