#!/usr/bin/env node
import process from "process";
import readline from "readline";
import path from "path";
import fs from "fs-extra";
import publishRelease from "publish-release";
import semver from "semver";
import shell from "shelljs";
import globby from "globby";
import Mustache from "mustache";
import yargs from "yargs";
import ssri from "ssri";
import parseGithubUrl from "parse-github-url";
import "colors";

const pkg = JSON.parse(fs.readFileSync("./package.json", "utf8"));
const settings = pkg["va-release"];

const bump = "patch, minor, major, prepatch, preminor, premajor, prerelease".split(", ");
const argv = yargs(process.argv.slice(3))
	.alias("g", "github")
	.describe("g", "release only to github")
	.boolean("g")
	.describe("no-templates", "disable templates build stage")
	.boolean("no-templates")
	.describe("no-git", "disable git push")
	.boolean("no-git")
	.describe("no-github", "disable github release")
	.boolean("no-github")
	.describe("no-npm", "disable npm release")
	.boolean("no-npm")
	.describe("token", "git release token")
	.alias("t", "templates")
	.boolean("t")
	.describe("t", "build templates")
	.alias("o", "otp")
	.alias("c", "comment")
	.describe("c", "commit comment")
	.alias("v", "version")
	.describe("v", "bump the version")
	.choices("v", bump)
	.version(false)
	.help("help").argv;

let currentFileDirectory = process.cwd();

const tryEx = (fn, def) => {
	try { return fn(); }
	catch (error) { return def; }
};

function get (src, path) {
	const p = path.replace(/["']/g, "").replace(/\[/g, ".").replace(/\]/g, "").split(".");
	let c = src;
	if (p[0]) {
		for (let i = 0; i < p.length; i++) {
			if (i === p.length - 1) {
				return c[p[i]];
			}
			c = c[p[i]];
			if (c == null || typeof c !== "object") {
				return undefined;
			}
		}
	}
	return c;
}

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



function doRelease () {
	const oldVersion = pkg.version;

	function restoreVersion () {
		pkg.version = oldVersion;
		fs.writeFileSync("./package.json", `${JSON.stringify(pkg, null, "\t")}\n`, "utf8");
	}

	function releaseNpm () {
		const npmReleaseFlag = !argv.github && !argv["no-npm"];
		try {
			if (npmReleaseFlag) {
				const rl = readline.createInterface({
					input: process.stdin,
					output: process.stdout,
				});
				rl.question(
					"Input npm otp password or leave it empty:",
					otp => {
						if (shell.exec("npm publish" + (otp ? ` --otp="${otp}"` : "")).code !== 0) {
							console.error("npm publish failed");
							process.exit(1);
							return;
						}
						console.log(`${pkg.name} v${pkg.version} published!`.green);
						rl.close();
					}
				);
			}
		}
		finally {
			//
		}
		return npmReleaseFlag;
	}

	let restoreVersionFlag = false;
	if (argv.version && !argv.templates) {
		pkg.version = semver.inc(pkg.version, argv.version);
		fs.writeFileSync("./package.json", `${JSON.stringify(pkg, null, "\t")}\n`, "utf8");
		restoreVersionFlag = true;
	}

	process.on("exit", code => {
		if (code != 0 && restoreVersionFlag) {
			restoreVersion();
		}
	});

	if (!argv["no-templates"]) {
		buildTemplates({
			version: pkg.version,
			timestamp: new Date(),
			package: pkg,
			repository: tryEx(() => parseGithubUrl(get(pkg, "repository.url") || "") || {}, {}),
			ssri () {
				return fp =>
					ssri.fromData(fs.readFileSync(
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
			},
		});
	}

	if (argv.templates) {
		return;
	}

	restoreVersionFlag = true;
	const releaseToken = argv.token || process.env.GIT_RELEASE_TOKEN;
	if (!argv["no-github"] && !releaseToken) {
		console.log("Error!".red, "Please specify github release token via " + "--token".cyan + " argument or " + "GIT_RELEASE_TOKEN".cyan + " enviroment variable.");
		process.exit(1);
		return;
	}

	try {
		const comment = argv.comment || argv._[0];
		if (!argv["no-git"]) {
			const res = shell.exec(`git add --all && (git diff-index --quiet HEAD || git commit -am "${pkg.version} - ${comment ? comment : `release commit`}") && git push`);
			if (res.code !== 0) {
				throw Error(res.stderr);
			}
		}

		restoreVersionFlag = false;
		const repoInfo = pkg.repository.url.match(/github.com\/([^/]*)\/([^/]*).git/);

		if (!argv["no-github"]) {
			publishRelease(
				{
					token: releaseToken,
					repo: repoInfo[2],
					owner: repoInfo[1],
					tag: `${pkg.version}`,
					name: `${pkg.name} v${pkg.version}`,
					assets:
						settings && settings.assets
							? globby.sync(settings.assets)
							: null,
				},
				error => {
					if (error) {
						console.error("release error", error);
						process.exit(1);
						return;
					}
					if (!releaseNpm()) {
						console.log(`${pkg.name} v${pkg.version} published!`.green);
					}
				}
			);
		}
		else {
			releaseNpm();
		}
	}
	catch (error) {
		console.log(error);
		process.exit(1);
	}
}

doRelease();



