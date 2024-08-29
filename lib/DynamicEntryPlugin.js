/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Naoyuki Kanezawa @nkzawa
*/

"use strict";

const EntryOptionPlugin = require("./EntryOptionPlugin");
const EntryPlugin = require("./EntryPlugin");
const EntryDependency = require("./dependencies/EntryDependency");






class DynamicEntryPlugin { 
	constructor(context, entry) {
		this.context = context;
		this.entry = entry;
	}
 
	apply(compiler) {
		compiler.hooks.compilation.tap(
			"DynamicEntryPlugin",
			(compilation, { normalModuleFactory }) => {
				compilation.dependencyFactories.set(
					EntryDependency,
					normalModuleFactory
				);
			}
		);

		compiler.hooks.make.tapPromise(
			"DynamicEntryPlugin",
			(compilation, callback) =>
				Promise.resolve(this.entry())
					.then(entry => {
						const promises = [];
						for (const name of Object.keys(entry)) {
							const desc = entry[name];
							const options = EntryOptionPlugin.entryDescriptionToOptions(
								compiler,
								name,
								desc
							);
							for (const entry of desc.import) {
								promises.push(
									new Promise((resolve, reject) => {
										compilation.addEntry(
											this.context,
											EntryPlugin.createDependency(entry, options),
											options,
											err => {
												if (err) return reject(err);
												resolve();
											}
										);
									})
								);
							}
						}
						return Promise.all(promises);
					})
					.then(x => {})
		);
	}
}

module.exports = DynamicEntryPlugin;
