import fs from "node:fs";

const file = process.argv[2];
fs.appendFileSync(file, "\n\nMy comment\n", "utf8");
