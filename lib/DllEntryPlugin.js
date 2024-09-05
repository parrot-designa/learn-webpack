/*
	该函数默认没有被调用
*/

"use strict";

const DllModuleFactory = require("./DllModuleFactory");
const DllEntryDependency = require("./dependencies/DllEntryDependency");
const EntryDependency = require("./dependencies/EntryDependency");





class DllEntryPlugin { 
	constructor(context, entries, options) {
		this.context = context;
		this.entries = entries;
		this.options = options;
	}
 
	apply(compiler) {
		compiler.hooks.compilation.tap(
			"DllEntryPlugin",
			(compilation, { normalModuleFactory }) => {
				const dllModuleFactory = new DllModuleFactory();
				compilation.dependencyFactories.set(
					DllEntryDependency,
					dllModuleFactory
				);
				compilation.dependencyFactories.set(
					EntryDependency,
					normalModuleFactory
				);
			}
		);
		compiler.hooks.make.tapAsync("DllEntryPlugin", (compilation, callback) => {
			compilation.addEntry(
				this.context,
				new DllEntryDependency(
					this.entries.map((e, idx) => {
						const dep = new EntryDependency(e);
						dep.loc = {
							name: this.options.name,
							index: idx
						};
						return dep;
					}),
					this.options.name
				),
				this.options,
				error => {
					if (error) return callback(error);
					callback();
				}
			);
		});
	}
}

module.exports = DllEntryPlugin;
