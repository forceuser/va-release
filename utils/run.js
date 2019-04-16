#!/usr/bin/env node
const process = require("process");
const path = require("path");
const fs = require("fs-extra");
const importModule = require("esm")(module, {cjs: true, mode: "auto", cache: false}, {cache: false});
require("@babel/register");
require("@babel/polyfill");
require("module-alias/register");

if (process.env.NODE_ENV === "test") {
	const tape = importModule("tape");
	tape.onFinish(async () => {
		await fs.mkdirs(path.resolve(process.cwd(), "./coverage"));
		await fs.writeFile(path.resolve(process.cwd(), "./coverage/coverage.json"), JSON.stringify(global.__coverage__ || {}), "utf-8");
	});
}

function getArg (args) {
	const idx = process.argv.findIndex((i, idx) => [].concat(args).some(v => typeof v === "string" ? v === i : v === idx));
	if (idx >= 0) {
		return process.argv[idx + 1];
	}
}

const script = getArg(["-s", "--script", 1]);
if (script) {
	module.exports = importModule(path.resolve(process.cwd(), script));
}
else {
	module.exports = importModule;
}

