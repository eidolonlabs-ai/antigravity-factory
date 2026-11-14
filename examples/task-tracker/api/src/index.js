import { createApp } from "./app.js";
import { pool } from "./db.js";

const port = Number(process.env.PORT) || 4000;
const app = createApp(pool);

app.listen(port, () => {
  console.log(`Tasks API listening on port ${port}`);
});
