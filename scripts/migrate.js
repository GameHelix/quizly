/* `npm run db:migrate`: brings the database up to date, over the direct
 * (unpooled) URL when there is one — see server/db.js. */

import { migrateUrl } from "../server/db.js";

const applied = await migrateUrl(process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL);
console.log(applied.length ? `applied: ${applied.join(", ")}` : "the schema is up to date");
