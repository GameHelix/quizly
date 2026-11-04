/* Vercel's entry point. vercel.json rewrites every /api/* request here, and
 * the same Express app that `npm start` runs handles it. The database pool
 * lives at module scope, so a warm instance reuses its connections, and
 * attachDatabasePool closes idle ones before Vercel suspends the instance.
 */

import { attachDatabasePool } from "@vercel/functions";
import { createApp, createContext } from "../server/app.js";
import { loadConfig } from "../server/config.js";

const context = createContext(loadConfig());
attachDatabasePool(context.pool);
attachDatabasePool(context.feedPool);

export default createApp(context);
