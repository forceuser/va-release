#!/usr/bin/env node
import process from "process";
import readline from "readline-promise";
import mime from "mime";
import path from "path";
import fs from "fs-extra";
import semver from "semver";
import shell from "shelljs";
import globby from "globby";
import Mustache from "mustache";
import yargs from "yargs";
import ssri from "ssri";
import parseGithubUrl from "parse-github-url";
import fetch from "isomorphic-fetch";
import camelcase from "camelcase";
import "colors";

const pkg = JSON.parse(fs.readFileSync("./package.json", "utf8"));
const settings = pkg["va-release"];

const bump = "patch, minor, major, prepatch, preminor, premajor, prerelease".split(", ");
const argv = yargs(process.argv.slice(2))
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

async function readln (question) {
	let result;
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
		terminal: true,
	});
	try {
		result = await rl.questionAsync(question);
	}
	finally {
		rl.close();
	}
	return result;
}

async function doRelease () {
	const comment = argv.comment || argv._[0];
	const oldVersion = pkg.version;
	const repository = pkg.repository ? tryEx(() => parseGithubUrl(get(pkg, "repository.url") || "") || {}, {}) : {name: pkg.name, owner: get(pkg, "va-release.owner")};
	pkg["va-release"] = pkg["va-release"] || {};
	if (!pkg["va-release"].library) {
		pkg["va-release"].library = camelcase(pkg.name);
	}

	function restoreVersion () {
		pkg.version = oldVersion;
		fs.writeFileSync("./package.json", `${JSON.stringify(pkg, null, "\t")}\n`, "utf8");
	}

	async function publishToGithub (repository, pkg, assets) {
		try {
			const publishResult = await fetch(`https://api.github.com/repos/${repository.owner}/${repository.name}/releases`, {
				method: "POST",
				redirect: "follow",
				headers: {
					"authorization": `token ${process.env.GIT_RELEASE_TOKEN}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					"tag_name": `v${pkg.version}`,
					"target_commitish": "master",
					"name": `${pkg.name} v${pkg.version}`,
					"body": comment ? comment : null,
					"draft": false,
					"prerelease": false,
				}),
			})
				.then(response => response.json());

			if (assets && assets.length) {
				await Promise.all(assets.map(async assetPath => {
					const name = path.basename(assetPath);

					const body = fs.createReadStream(assetPath);
					const stats = fs.statSync(assetPath);
					try {
						const response = await fetch(`${publishResult.upload_url.replace(/\{.*?\}/ig, "")}?name=${name}`, {
							method: "POST",
							redirect: "follow",
							headers: {
								"authorization": `token ${process.env.GIT_RELEASE_TOKEN}`,
								"content-type": mime.getType(assetPath),
								"content-length": stats.size,
							},
							body,
						});

						if (response.status !== 201) {
							throw new Error("failed to upload");
						}
					}
					catch (error) {
						console.log(`${"Error!".red} asset ${assetPath.cyan} not uploaded`);
					}
				}));
				console.log("github release assets upload if finished!");
			}
		}
		catch (error) {
			console.log("error while publishing to github!".red);
		}
	}

	function isGitRepo () {
		return fs.existsSync("./.git");
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
			repository,
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

		if (!argv["no-git"]) {
			if (!isGitRepo()) {
				const response = await fetch(`https://api.github.com/user/repos`, {
					method: "POST",
					redirect: "follow",
					headers: {
						"authorization": `token ${process.env.GIT_RELEASE_TOKEN}`,
						"content-type": "application/json",
					},
					body: JSON.stringify({"name": "va-create"}),
				})
					.then(response => response.json());

				const res = shell.exec(`git init && git add --all && git commit -am "${pkg.version} - ${comment ? comment : `release commit`}" && git remote add origin ${response.ssh_url} && git push -u origin master`);
				if (res.code !== 0) {
					throw Error(res.stderr);
				}
			}
			else {
				const res = shell.exec(`git add --all && (git diff-index --quiet HEAD || git commit -am "${pkg.version} - ${comment ? comment : `release commit`}") && git push`);
				if (res.code !== 0) {
					throw Error(res.stderr);
				}
			}
		}

		restoreVersionFlag = false;
		if (!argv["no-github"]) {
			try {
				await publishToGithub(repository, pkg, settings && settings.assets ? globby.sync(settings.assets) : []);
				console.log(`${pkg.name} v${pkg.version} published to github!`.green);
			}
			catch (error) {
				if (error) {
					console.error("release error", error);
					process.exit(1);
					return;
				}
			}
		}

		if (!argv.github && !argv["no-npm"]) {
			const otp = await readln("Input npm otp password or leave it empty: ");
			if (shell.exec("npm publish" + (otp ? ` --otp="${otp}"` : "")).code !== 0) {
				console.error("npm publish failed");
				process.exit(1);
				return;
			}
			console.log(`${pkg.name} v${pkg.version} published to npm!`.green);
		}
	}
	catch (error) {
		console.log(error);
		process.exit(1);
	}
}

doRelease();



