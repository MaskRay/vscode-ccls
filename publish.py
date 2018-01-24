#!/usr/bin/env python

import subprocess
import sys

if __name__ == "__main__":
  # patch|minor|major
  CMD = 'patch'
  if len(sys.argv) > 1 and sys.argv[1]:
    CMD = sys.argv[1]

  # patch | minor | major
  if subprocess.call(['npm', 'version', CMD]) != 0:
    sys.exit(1)
  sys.exit(subprocess.call(['git', 'push', 'origin', 'master', '--follow-tags']))


