import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { GraphQLClient } from "../graphqlClient.js";
import { receipt } from "../util/mcp.js";
import {
  connectWorkspaceSocket,
  joinWorkspace,
  wsUrlFromGraphQLEndpoint,
  type WorkspaceSocket,
} from "../ws.js";
import {
  docIconEntries,
  docIconKey,
  folderIconKey,
  getExplorerIcon,
  normalizeIconInput,
  setExplorerIcon,
  setExplorerIcons,
  type ExplorerIconInput,
} from "../util/explorerIcon.js";

/**
 * Zod shape for the `icon` parameter shared by both setters. Accepts an emoji
 * shorthand string, a full `{type:"emoji",unicode}` / `{type:"affine-icon",name,color?}`
 * object, or `null` to clear the icon. `"icon"` is accepted as an alias for `"affine-icon"`.
 */
export const iconSchema = z
  .union([
    z.string(),
    z.object({ type: z.literal("emoji"), unicode: z.string() }),
    z.object({
      type: z.enum(["affine-icon", "icon"]),
      name: z.string(),
      color: z
        .string()
        .optional()
        .describe(
          'Any CSS color, e.g. "#EB4C42". AFFiNE\'s picker palette uses theme-aware ' +
            '"var(--affine-v2-block-callout-icon-<red|orange|yellow|green|teal|blue|purple|magenta|grey>)".',
        ),
    }),
    z.null(),
  ])
  .describe(
    'Emoji shorthand ("🧪"), a full object ({type:"emoji",unicode:"🧪"} or ' +
      '{type:"affine-icon",name:"FlagPanel",color:"var(--affine-v2-block-callout-icon-red)"}), ' +
      "or null to remove the icon. `name` must be an @blocksuite/icons export without the " +
      '`Icon` suffix (e.g. "FlagPanel", "DirectionSignPanel"); unknown names render as no icon.',
  );

/**
 * Registers the explorer-icon tools: set/clear and read the Notion-style
 * sidebar icon on a document or an organize folder. All four share the
 * `explorerIcon` sub-doc helper so the storage model lives in one place.
 */
export function registerIconTools(
  server: McpServer,
  gql: GraphQLClient,
  defaults: { workspaceId?: string },
) {
  function resolveWorkspaceId(workspaceId?: string): string {
    const resolved = workspaceId || defaults.workspaceId;
    if (!resolved) {
      throw new Error(
        "workspaceId is required. Provide it as a parameter or set AFFINE_WORKSPACE_ID.",
      );
    }
    return resolved;
  }

  async function withSocket<T>(
    workspaceId: string,
    fn: (socket: WorkspaceSocket) => Promise<T>,
  ): Promise<T> {
    const { endpoint, cookie, bearer } = await gql.getConnectionAuth();
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, cookie, bearer);
    try {
      await joinWorkspace(socket, workspaceId);
      return await fn(socket);
    } finally {
      socket.disconnect();
    }
  }

  // ─── update_doc_icon ────────────────────────────────────────────────────────
  const updateDocIconHandler = async (parsed: {
    workspaceId?: string;
    docId: string;
    icon: ExplorerIconInput;
  }) => {
    const workspaceId = resolveWorkspaceId(parsed.workspaceId);
    const icon = normalizeIconInput(parsed.icon);
    const result = await withSocket(workspaceId, (socket) =>
      setExplorerIcon(socket, workspaceId, docIconKey(parsed.docId), icon),
    );
    return receipt("doc.update_icon", {
      workspaceId,
      docId: parsed.docId,
      icon: result.icon,
      cleared: result.icon === null,
    });
  };
  server.registerTool(
    "update_doc_icon",
    {
      title: "Update Document Icon",
      description:
        "Set or clear the sidebar icon (the Notion-style emoji slot) on a document. " +
        "Pass an emoji string, a full icon object, or null to remove it.",
      inputSchema: {
        workspaceId: z.string().optional(),
        docId: z.string().describe("The document whose icon to update."),
        icon: iconSchema,
      },
    },
    updateDocIconHandler as any,
  );

  // ─── update_doc_icons ───────────────────────────────────────────────────────
  const updateDocIconsHandler = async (parsed: {
    workspaceId?: string;
    icons: Array<{ docId: string; icon: ExplorerIconInput }>;
  }) => {
    const workspaceId = resolveWorkspaceId(parsed.workspaceId);
    const entries = docIconEntries(parsed.icons); // Validate everything before any write.
    await withSocket(workspaceId, (socket) => setExplorerIcons(socket, workspaceId, entries));
    return receipt("doc.update_icons", {
      workspaceId,
      count: entries.length,
      icons: entries.map(({ key, icon }) => ({ docId: key.slice("doc:".length), icon })),
    });
  };
  server.registerTool(
    "update_doc_icons",
    {
      title: "Update Document Icons",
      description:
        "Set or clear the sidebar icon on many documents with one write. Each item is " +
        "{docId, icon} where icon is an emoji string, a full icon object, or null to clear. " +
        "Atomic: invalid items or duplicate docIds reject the whole call.",
      inputSchema: {
        workspaceId: z.string().optional(),
        icons: z.array(z.object({ docId: z.string().min(1), icon: iconSchema })).min(1).max(200),
      },
    },
    updateDocIconsHandler as any,
  );

  // ─── update_folder_icon ─────────────────────────────────────────────────────
  const updateFolderIconHandler = async (parsed: {
    workspaceId?: string;
    folderId: string;
    icon: ExplorerIconInput;
  }) => {
    const workspaceId = resolveWorkspaceId(parsed.workspaceId);
    const icon = normalizeIconInput(parsed.icon);
    const result = await withSocket(workspaceId, (socket) =>
      setExplorerIcon(socket, workspaceId, folderIconKey(parsed.folderId), icon),
    );
    return receipt("folder.update_icon", {
      workspaceId,
      folderId: parsed.folderId,
      icon: result.icon,
      cleared: result.icon === null,
    });
  };
  server.registerTool(
    "update_folder_icon",
    {
      title: "Update Folder Icon",
      description:
        "Set or clear the sidebar icon on an organize folder. " +
        "Pass an emoji string, a full icon object, or null to remove it. Experimental.",
      inputSchema: {
        workspaceId: z.string().optional(),
        folderId: z.string().describe("The organize folder whose icon to update."),
        icon: iconSchema,
      },
    },
    updateFolderIconHandler as any,
  );

  // ─── get_doc_icon ───────────────────────────────────────────────────────────
  const getDocIconHandler = async (parsed: { workspaceId?: string; docId: string }) => {
    const workspaceId = resolveWorkspaceId(parsed.workspaceId);
    const result = await withSocket(workspaceId, (socket) =>
      getExplorerIcon(socket, workspaceId, docIconKey(parsed.docId)),
    );
    return receipt("doc.get_icon", {
      workspaceId,
      docId: parsed.docId,
      icon: result.icon,
      hasIcon: result.icon !== null,
    });
  };
  server.registerTool(
    "get_doc_icon",
    {
      title: "Get Document Icon",
      description: "Read the current sidebar icon of a document. Returns null when none is set.",
      inputSchema: {
        workspaceId: z.string().optional(),
        docId: z.string().describe("The document whose icon to read."),
      },
    },
    getDocIconHandler as any,
  );

  // ─── get_folder_icon ────────────────────────────────────────────────────────
  const getFolderIconHandler = async (parsed: { workspaceId?: string; folderId: string }) => {
    const workspaceId = resolveWorkspaceId(parsed.workspaceId);
    const result = await withSocket(workspaceId, (socket) =>
      getExplorerIcon(socket, workspaceId, folderIconKey(parsed.folderId)),
    );
    return receipt("folder.get_icon", {
      workspaceId,
      folderId: parsed.folderId,
      icon: result.icon,
      hasIcon: result.icon !== null,
    });
  };
  server.registerTool(
    "get_folder_icon",
    {
      title: "Get Folder Icon",
      description:
        "Read the current sidebar icon of an organize folder. Returns null when none is set. Experimental.",
      inputSchema: {
        workspaceId: z.string().optional(),
        folderId: z.string().describe("The organize folder whose icon to read."),
      },
    },
    getFolderIconHandler as any,
  );
}
