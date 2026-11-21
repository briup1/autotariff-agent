import { it, expect } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import {
  executeParser,
  type IsolationDescriptor,
} from "../src/closure/execute.js";
import { PROJECT_ROOT, PYTHON, runsRootFor } from "../src/closure/paths.js";
import { ArtifactStore, digest } from "../src/closure/artifacts.js";
const root = resolve(PROJECT_ROOT, ".tmp/sandbox-test");
it("OS sandbox denies secrets, other attempts, legacy writes, network and forks; kills timeout and memory excess", async () => {
  await mkdir(root, { recursive: true });
  const src = resolve(root, "input.txt"),
    parser = resolve(root, "parser.py"),
    out = resolve(root, "result.json");
  await writeFile(src, "ok");
  const isolation: IsolationDescriptor = {
    provider: "macos_sandbox",
    network: "disabled",
    readRoots: [src, parser],
    writeRoots: [root],
    timeoutSeconds: 3,
  };
  const script = `import json,sys,os,socket\nchecks={}\nfor key,fn in {"secret":lambda:open(${JSON.stringify(resolve(PROJECT_ROOT, ".env.local"))}).read(),"other":lambda:open(${JSON.stringify(resolve(PROJECT_ROOT, "template_runs/outside.txt"))},"w").write("bad"),"legacy":lambda:open(${JSON.stringify(resolve(PROJECT_ROOT, "../autotariffextract/.sandbox-probe"))},"w").write("bad"),"network":lambda:socket.create_connection(("1.1.1.1",80),1),"fork":lambda:os.fork()}.items():\n try:fn();checks[key]="ALLOWED"\n except OSError:checks[key]="DENIED"\nchecks["environment"]="DENIED" if not any("KEY" in k or "TOKEN" in k or "SECRET" in k for k in os.environ) else "ALLOWED"\njson.dump([checks],open(sys.argv[2],"w"))\n`;
  const protectedScript = script
    .replace(
      "checks={}",
      'def parent_environment():\n import ctypes\n libc=ctypes.CDLL(None,use_errno=True)\n mib=(ctypes.c_int*3)(1,49,os.getppid())\n size=ctypes.c_size_t(1048576)\n buf=ctypes.create_string_buffer(size.value)\n if libc.sysctl(mib,3,buf,ctypes.byref(size),None,0)!=0: raise OSError(ctypes.get_errno(),"parent environment denied")\nchecks={}',
    )
    .replace(
      '"fork":lambda:os.fork()',
      '"parent_environment":parent_environment,"fork":lambda:os.fork()',
    );
  await writeFile(parser, protectedScript);
  const rows = await executeParser(PYTHON, parser, src, out, isolation);
  expect(Object.values(rows[0])).toEqual(Array(7).fill("DENIED"));
  await writeFile(parser, "while True: pass");
  await expect(
    executeParser(PYTHON, parser, src, out, {
      ...isolation,
      timeoutSeconds: 0.2,
    }),
  ).rejects.toThrow("timeout");
  await writeFile(
    parser,
    "import time; a=bytearray(128*1024**2); time.sleep(2)",
  );
  await expect(
    executeParser(PYTHON, parser, src, out, {
      ...isolation,
      memoryBytes: 64 * 1024 ** 2,
    }),
  ).rejects.toThrow("memory limit");
  await new ArtifactStore(PROJECT_ROOT).put(
    `sandbox-proof-${Date.now()}`,
    "report.json",
    JSON.stringify(
      {
        provider: "macos_sandbox",
        scriptSha256: digest(protectedScript),
        checks: rows[0],
        timeoutTerminated: true,
        memoryTerminated: true,
        rssSamplingMs: 25,
      },
      null,
      2,
    ),
    "sandbox-proof",
  );
  await rm(root, { recursive: true, force: true });
}, 15000);
