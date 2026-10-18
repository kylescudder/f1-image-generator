import { closeConnection, connection } from "./database.ts";
import { migrate } from "./schema.ts";

try {
  await migrate(await connection());
  console.log("Paddock schema is ready");
} finally {
  await closeConnection();
}
