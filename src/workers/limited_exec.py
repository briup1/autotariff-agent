"""Trusted launcher: hard limits apply before running candidate Python."""
import os
import resource
import runpy
import sys
import mimetypes

cpu, memory, size = map(int, sys.argv[1:4])
resource.setrlimit(resource.RLIMIT_CPU, (cpu, cpu))
# macOS rejects RLIMIT_AS/DATA; the host enforces RSS with an OS process watchdog.
resource.setrlimit(resource.RLIMIT_FSIZE, (size, size))
resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
mimetypes.knownfiles = []
mimetypes.init(files=[])
sys.argv = sys.argv[4:]
runpy.run_path(sys.argv[0], run_name="__main__")
