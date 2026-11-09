#!/usr/bin/env node
import { testResourceName, testTempPath } from './require-destructive-test-safety.mjs';

/**
 * Integration test for icon and tag decoration: create_doc with icon + tags, add_tags_to_docs and update_doc_icons.
 * Batches are atomic, so each rejection case also checks that nothing changed.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_SERVER_PATH = path.resolve(__dirname, "..", "dist", "index.js");

const BASE_URL = process.env.AFFINE_BASE_URL || "http://localhost:3010";
const EMAIL = process.env.AFFINE_ADMIN_EMAIL || process.env.AFFINE_EMAIL || "test@affine.local";
const PASSWORD = process.env.AFFINE_ADMIN_PASSWORD || process.env.AFFINE_PASSWORD;
if (!PASSWORD) throw new Error("AFFINE_ADMIN_PASSWORD env var required — run: . tests/generate-test-env.sh");
const TOOL_TIMEOUT_MS = Number(process.env.MCP_TOOL_TIMEOUT_MS || "60000");

function parseContent(result) {
  const text = result?.content?.[0]?.text;
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function expectEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function main() {
  console.log("=== Doc Decoration Integration Test ===");
  const client = new Client({ name: "affine-mcp-doc-decoration", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: "node",
    args: [MCP_SERVER_PATH],
    cwd: path.resolve(__dirname, ".."),
    env: {
      AFFINE_BASE_URL: BASE_URL,
      AFFINE_EMAIL: EMAIL,
      AFFINE_PASSWORD: PASSWORD,
      AFFINE_LOGIN_AT_START: "sync",
      XDG_CONFIG_HOME: testTempPath("doc-decoration-config"),
    },
    stderr: "pipe",
  });
  transport.stderr?.on("data", chunk => process.stderr.write(`[mcp-server] ${chunk}`));

  async function call(toolName, args = {}) {
    const result = await client.callTool({ name: toolName, arguments: args }, undefined, { timeout: TOOL_TIMEOUT_MS });
    const parsed = parseContent(result);
    if (result?.isError) throw new Error(`${toolName} MCP error: ${result?.content?.[0]?.text || "unknown"}`);
    console.log(`  ✓ ${toolName}`);
    return parsed;
  }

  async function rejects(toolName, args, message) {
    try {
      await call(toolName, args);
    } catch {
      return;
    }
    throw new Error(`${message}: expected ${toolName} to fail`);
  }

  await client.connect(transport);
  try {
    const run = testResourceName("run");
    const { id: workspaceId } = await call("create_workspace", { name: `doc-decoration-${run}` });
    expect(workspaceId, "create_workspace id");

    const created = await call("create_doc", { workspaceId, title: `Decorated ${run}`, icon: "🧭", tags: ["type/guide"] });
    expectEqual(created.warnings, [], "create_doc icon/tags produced no warnings");
    expectEqual((await call("get_doc_icon", { workspaceId, docId: created.docId })).icon?.unicode, "🧭", "create_doc icon applied");
    expect((await call("read_doc", { workspaceId, docId: created.docId })).tags.includes("type/guide"), "create_doc tag applied");
    await rejects("create_doc", { workspaceId, title: `Invalid ${run}`, tags: [" "] }, "blank tag rejected before the doc is created");

    const a = await call("create_doc", { workspaceId, title: `A ${run}` });
    const b = await call("create_doc", { workspaceId, title: `B ${run}` });
    const tagged = await call("add_tags_to_docs", { workspaceId, docIds: [a.docId, b.docId], tags: ["topic/x", "topic/y"] });
    for (const doc of tagged.docs) expectEqual([...doc.tags].sort(), ["topic/x", "topic/y"], "each doc has both tags");
    expectEqual((await call("add_tags_to_docs", { workspaceId, docIds: [a.docId], tags: ["topic/x"] })).changed, false, "re-tagging is a no-op");
    await rejects("add_tags_to_docs", { workspaceId, docIds: [a.docId, "missing-doc"], tags: ["topic/z"] }, "unknown docId rejects the batch");
    expect(!(await call("read_doc", { workspaceId, docId: a.docId })).tags.includes("topic/z"), "rejected batch tagged nothing");

    await call("update_doc_icons", { workspaceId, icons: [{ docId: a.docId, icon: "🚀" }, { docId: b.docId, icon: "🌱" }] });
    expectEqual((await call("get_doc_icon", { workspaceId, docId: b.docId })).icon?.unicode, "🌱", "batch icon applied");
    await rejects("update_doc_icons", { workspaceId, icons: [{ docId: a.docId, icon: "x" }, { docId: a.docId, icon: "y" }] }, "duplicate docIds reject the batch");
    expectEqual((await call("get_doc_icon", { workspaceId, docId: a.docId })).icon?.unicode, "🚀", "rejected batch left the icon unchanged");
    await call("update_doc_icons", { workspaceId, icons: [{ docId: a.docId, icon: null }] });
    expectEqual((await call("get_doc_icon", { workspaceId, docId: a.docId })).hasIcon, false, "batch can clear an icon")

    console.log("\nDoc Decoration Integration Test passed");
  } finally {
    await client.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
