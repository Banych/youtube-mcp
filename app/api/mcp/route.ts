import { createServer } from "../../../lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const handler = createServer(
  () => ({ channels: process.env.YT_CHANNELS, token: process.env.MCP_TOKEN }),
  { fetch },
);

export { handler as GET, handler as POST, handler as DELETE };
