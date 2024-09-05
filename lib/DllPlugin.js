/*
	该函数默认没有被调用
*/

"use strict";

const DllEntryPlugin = require("./DllEntryPlugin");
const FlagAllModulesAsUsedPlugin = require("./FlagAllModulesAsUsedPlugin");
const LibManifestPlugin = require("./LibManifestPlugin");
const createSchemaValidation = require("./util/create-schema-validation"); 

const validate = createSchemaValidation(
	require("../schemas/plugins/DllPlugin.check.js"),
	() => require("../schemas/plugins/DllPlugin.json"),
	{
		name: "Dll Plugin",
		baseDataPath: "options"
	}
);

class DllPlugin { 
	constructor(options) {
		validate(options);
		this.options = {
			...options,
			entryOnly: options.entryOnly !== false
		};
	}
 
	apply(compiler) {
		compiler.hooks.entryOption.tap("DllPlugin", (context, entry) => {
			if (typeof entry !== "function") {
				for (const name of Object.keys(entry)) { 
					const options = { name, filename: entry.filename };
					new DllEntryPlugin(
						context,
						(entry[name].import),
						options
					).apply(compiler);
				}
			} else {
				throw new Error(
					"DllPlugin doesn't support dynamic entry (function) yet"
				);
			}
			return true;
		});
		new LibManifestPlugin(this.options).apply(compiler);
		if (!this.options.entryOnly) {
			new FlagAllModulesAsUsedPlugin("DllPlugin").apply(compiler);
		}
	}
}

module.exports = DllPlugin;
