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
import fetch from "isomorphic-fetch";
import FormData from "form-data";
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



async function doRelease () {
	const comment = argv.comment || argv._[0];
	const oldVersion = pkg.version;
	const repository = tryEx(() => parseGithubUrl(get(pkg, "repository.url") || "") || {}, {});

	function restoreVersion () {
		pkg.version = oldVersion;
		fs.writeFileSync("./package.json", `${JSON.stringify(pkg, null, "\t")}\n`, "utf8");
	}

	async function publishToGithub (repository, pkg, assets) {
		console.log("publishToGithub", assets);
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

			console.log("publishResult", publishResult);
			if (assets && assets.length) {
				await Promise.all(assets.map(async assetPath => {
					const name = path.basename(assetPath, path.extname(assetPath));
					console.log("assetPath", assetPath);
					const body = new FormData();
					body.append("file", fs.createReadStream(assetPath));
					try {
						const response = await fetch(`${publishResult.assets_url}?name=${name}`, {
							method: "POST",
							redirect: "follow",
							headers: {
								"authorization": `token ${process.env.GIT_RELEASE_TOKEN}`,
							},
							body,
						});

						console.log("asset upload", name, response);
					}
					catch (error) {
						console.log("asset upload error!".red);
					}
				}));
				console.log("github release assets uploading is finished!");
			}
		}
		catch (error) {
			console.log("error while publishing to github!".red);
		}
	}

	function isGitRepo () {
		const res = fs.existsSync("./.git");
		console.log("isGitRepo", res);
		return res;
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
					console.log(`${pkg.name} v${pkg.version} published to npm!`.green);
					rl.close();
				}
			);
		}
	}
	catch (error) {
		console.log(error);
		process.exit(1);
	}
}

doRelease();



