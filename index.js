#!/usr/bin/env node

/* global process */

const readline = require("readline");
const process = require("process");
const path = require("path");
const fs = require("fs-extra");
const publishRelease = require("publish-release");
const semver = require("semver");
const shell = require("shelljs");
const globby = require("globby");
const Mustache = require("mustache");
const ssri = require("ssri");

require("colors");

const bump = "patch, minor, major, prepatch, preminor, premajor, prerelease".split(
	", "
);
const argv = require("yargs")
	.alias("g", "github")
	.describe("g", "release only to github")
	.alias("t", "templates")
	.describe("t", "build templates")
	.alias("o", "otp")
	.alias("v", "version")
	.describe("v", "bump the version")
	.choices("v", bump)
	.help("help").argv;

console.log("argv.otp", argv.otp);

function restoreVersion () {
	pkg.version = oldVersion;
	fs.writeFileSync(
		"./package.json",
		`${JSON.stringify(pkg, null, "\t")}\n`,
		"utf8"
	);
}

let currentFileDirectory = process.cwd();
function buildTemplates (params) {
	if (settings && settings.files && settings.files.length) {
		settings.files.forEach(file => {
			globby.sync(file.src, {cwd: file.cwd}).forEach(fp => {
				currentFileDirectory = file.cwd;
				fs.writeFileSync(
					path.resolve(file.dest, fp),
					Mustache.render(
						fs.readFileSync(
							path.resolve(file.cwd || "./", fp),
							"utf8"
						),
						params || {}
					)
				);
			});
		});
	}
}

const pkg = JSON.parse(fs.readFileSync("./package.json", "utf8"));
const oldVersion = pkg.version;
const settings = pkg["va-release"];

if (argv.version && !argv.templates) {
	pkg.version = semver.inc(pkg.version, argv.version);
}

buildTemplates({
	version: pkg.version,
	timestamp: new Date(),
	package: pkg,
	ssri (fp) {
		return ssri.fromData(fs.readFileSync(
			path.resolve(currentFileDirectory || "./", fp),
			"utf8"
		));
	},
	file () {
		return fp =>
			fs.readFileSync(
				path.resolve(currentFileDirectory || "./", fp),
				"utf8"
			);
	}
});

if (argv.templates) {
	return;
}

fs.writeFileSync(
	"./package.json",
	`${JSON.stringify(pkg, null, "\t")}\n`,
	"utf8"
);
process.on("exit", code => {
	if (code != 0) {
		restoreVersion();
	}
});
try {
	const res = shell.exec(
		`git add --all && (git diff-index --quiet HEAD || git commit -am "${
			pkg.version
		} release commit") && git push`
	);

	if (res.code !== 0) {
		throw Error(res.stderr);
	}

	const repoInfo = pkg.repository.url.match(
		/github.com\/([^/]*)\/([^/]*).git/
	);
	publishRelease(
		{
			token: process.env.GIT_RELEASE_TOKEN,
			repo: repoInfo[2],
			owner: repoInfo[1],
			tag: `${pkg.version}`,
			name: `${pkg.name} v${pkg.version}`,
			assets:
				settings && settings.assets
					? globby.sync(settings.assets)
					: null
		},
		(error, release) => {
			if (error) {
				console.error("release error", error);
				process.exit(1);
				return;
			}
			else if (!argv.github) {
				const rl = readline.createInterface({
					input: process.stdin,
					output: process.stdout
				});
				rl.question(
					"Input npm otp password or leave it empty:",
					otp => {
						if (
							shell.exec(
								"npm publish" + (otp ? ` --otp="${otp}"` : "")
							).code !== 0
						) {
							console.error("npm publish failed");
							process.exit(1);
							return;
						}
						console.log(
							`${pkg.name} v${pkg.version} published!`.green
						);
						rl.close();
					}
				);
			}
			else {
				console.log(`${pkg.name} v${pkg.version} published!`.green);
			}
		}
	);
}
catch (error) {
	console.log(error);
	process.exit(1);
}
