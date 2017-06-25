#!/usr/bin/env node

/* global process */

const path = require("path");
const fs = require("fs-extra");
const publishRelease = require("publish-release");
const semver = require("semver");
// const shell = require("shelljs");
const globby = require("globby");
const Mustache = require("mustache");

const bump = "patch, minor, major, prepatch, preminor, premajor, prerelease".split(", ");
const argv = require('yargs') // eslint-disable-line
	.alias("v", "version")
	.describe("v", "bump the version")
	.choices("v", bump)
	.help("help")
	.argv;


function restoreVersion () {
	pkg.version = oldVersion;
	fs.writeFileSync("./package.json", `${JSON.stringify(pkg, null, "\t")}\n`, "utf8");
}

function buildTemplates (params) {
	if (settings && settings.files && settings.files.length) {
		settings.files.forEach(file => {
			globby.sync(file.src, {cwd: file.cwd}).forEach(fp => {
				fs.writeFileSync(path.resolve(file.dest, fp), Mustache.render(fs.readFileSync(path.resolve(file.cwd || "./", fp), "utf8"), params || {}));
			});
		});
	}
}

const pkg = JSON.parse(fs.readFileSync("./package.json", "utf8"));
const oldVersion = pkg.version;
const settings = pkg["va-release"];

if (argv.version) {
	pkg.version = semver.inc(pkg.version, argv.version);
}
buildTemplates({version: pkg.version, timestamp: new Date()});

fs.writeFileSync("./package.json", `${JSON.stringify(pkg, null, "\t")}\n`, "utf8");

try {
	const repoInfo = pkg.repository.url.match(/github.com\/([^/]*)\/([^/]*).git/);

	publishRelease({
		token: process.env.GIT_RELEASE_TOKEN,
		repo: repoInfo[2],
		owner: repoInfo[1],
		tag: `${pkg.version}`,
		name: `${pkg.name} v${pkg.version}`,
		assets: settings && settings.assets ? globby.sync(settings.assets) : null
	}, (error, release) => {
		if (error) {
			restoreVersion();
			console.error("release error", error);
			process.exit(1);
		}
	});
}
catch (error) {
	restoreVersion();
	process.exit(1);
}
