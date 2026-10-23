import { db } from "@highodds/db";
import { capturePaperResearch } from "./paper-research.js";
try { console.log(JSON.stringify(await capturePaperResearch())); }
catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode=1; }
finally { await db.$disconnect(); }
