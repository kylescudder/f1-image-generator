import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("receiver enforces signature, timestamp, size, exact path and queue limit", async () => {
  const directory = mkdtempSync(join(tmpdir(), "paddock-hook-test-"));
  const secret = "isolated-test-fixture-signing-key-only";
  for (const sub of ["tmp", "requests"]) mkdirSync(join(directory, sub));
  writeFileSync(join(directory, "secret"), secret, { mode: 0o600 });
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("./server.mjs", import.meta.url))],
    {
      env: {
        ...process.env,
        WEBHOOK_SECRET_FILE: join(directory, "secret"),
        SPOOL_DIR: directory,
        PORT: "19000",
        DEPLOYED_STATE_FILE: join(directory, "deployment.json"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Receiver failed to listen")),
        5000,
      );
      child.stdout.on("data", (d) => {
        if (d.toString().includes("listening")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("Receiver exited"));
      });
    });
    const value = {
      digest: "sha256:" + "a".repeat(64),
      revision: "b".repeat(40),
      timestamp: Math.floor(Date.now() / 1000),
    };
    const send = async (body, signature, path = "/hooks/paddock") =>
      fetch("http://127.0.0.1:19000" + path, {
        method: "POST",
        body,
        headers: { "X-Paddock-Signature": signature },
      });
    const signed = (body) =>
      "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
    const body = JSON.stringify(value);
    const status = () => fetch("http://127.0.0.1:19000/hooks/paddock");
    assert.deepEqual(await (await status()).json(), { status: "pending" });
    for (const invalid of [
      "{",
      JSON.stringify({ revision: value.revision, image: "untrusted:main" }),
    ]) {
      writeFileSync(join(directory, "deployment.json"), invalid);
      assert.deepEqual(await (await status()).json(), { status: "pending" });
    }
    const deployed = {
      revision: value.revision,
      image: "ghcr.io/kylescudder/f1-image-generator@" + value.digest,
    };
    writeFileSync(
      join(directory, "deployment.json"),
      JSON.stringify({ ...deployed, private: "must not be returned" }),
    );
    const accepted = await status();
    assert.equal(accepted.headers.get("Cache-Control"), "no-store");
    assert.deepEqual(await accepted.json(), {
      status: "deployed",
      ...deployed,
    });
    assert.equal(
      (await fetch("http://127.0.0.1:19000/hooks/paddock?x=1")).status,
      404,
    );
    const denied = await send(body, "sha256=wrong");
    assert.equal(denied.status, 401);
    assert.equal(denied.headers.get("X-Paddock-Deploy-Hook"), "1");
    assert.equal(readdirSync(join(directory, "requests")).length, 0);
    for (const invalid of [
      { ...value, timestamp: value.timestamp - 600 },
      { ...value, digest: "invalid" },
      { ...value, revision: "invalid" },
    ]) {
      const data = JSON.stringify(invalid);
      assert.equal((await send(data, signed(data))).status, 400);
    }
    assert.equal((await send("broken", signed("broken"))).status, 400);
    assert.equal((await send("x".repeat(1025), "invalid")).status, 413);
    for (const path of ["/", "/other", "/hooks/paddock?x=1"])
      assert.equal((await send(body, signed(body), path)).status, 404);
    assert.equal((await fetch("http://127.0.0.1:19000/healthz")).status, 200);
    assert.equal((await send(body, signed(body))).status, 202);
    assert.equal(readdirSync(join(directory, "requests")).length, 1);
    assert.equal(readdirSync(join(directory, "tmp")).length, 0);
    for (let i = 0; i < 63; i++)
      writeFileSync(join(directory, "requests", `fixture-${i}.json`), "{}");
    assert.equal((await send(body, signed(body))).status, 503);
    assert.equal(readdirSync(join(directory, "requests")).length, 64);
  } finally {
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});
