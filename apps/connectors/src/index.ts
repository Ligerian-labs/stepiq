import { serve } from "@hono/node-server";
import { app } from "./app.js";

const port = Number(process.env.CONNECTORS_PORT || 3002);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`🔌 Connectors gateway listening on http://localhost:${info.port}`);
});
