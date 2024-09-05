/*
	MIT License http://www.opensource.org/licenses/mit-license.php
*/

"use strict";

const memoize = require("./memoize"); 

const getBinaryMiddleware = memoize(() =>
	require("../serialization/BinaryMiddleware")
);
const getObjectMiddleware = memoize(() =>
	require("../serialization/ObjectMiddleware")
);
const getSingleItemMiddleware = memoize(() =>
	require("../serialization/SingleItemMiddleware")
);
const getSerializer = memoize(() => require("../serialization/Serializer"));
const getSerializerMiddleware = memoize(() =>
	require("../serialization/SerializerMiddleware")
);

const getBinaryMiddlewareInstance = memoize(
	() => new (getBinaryMiddleware())()
);

const registerSerializers = memoize(() => {
	require("./registerExternalSerializer");

	// Load internal paths with a relative require
	// This allows bundling all internal serializers
	const internalSerializables = require("./internalSerializables");
	getObjectMiddleware().registerLoader(/^webpack\/lib\//, req => {
		const loader =
			internalSerializables[
				/** @type {keyof import("./internalSerializables")} */
				(req.slice("webpack/lib/".length))
			];
		if (loader) {
			loader();
		} else {
			console.warn(`${req} not found in internalSerializables`);
		}
		return true;
	});
});
 
let buffersSerializer;
 
module.exports = {
	get register() {
		return getObjectMiddleware().register;
	},
	get registerLoader() {
		return getObjectMiddleware().registerLoader;
	},
	get registerNotSerializable() {
		return getObjectMiddleware().registerNotSerializable;
	},
	get NOT_SERIALIZABLE() {
		return getObjectMiddleware().NOT_SERIALIZABLE;
	}, 
	get MEASURE_START_OPERATION() {
		return getBinaryMiddleware().MEASURE_START_OPERATION;
	}, 
	get MEASURE_END_OPERATION() {
		return getBinaryMiddleware().MEASURE_END_OPERATION;
	}, 
	get buffersSerializer() {
		if (buffersSerializer !== undefined) return buffersSerializer;
		registerSerializers();
		const Serializer = getSerializer();
		const binaryMiddleware = getBinaryMiddlewareInstance();
		const SerializerMiddleware = getSerializerMiddleware();
		const SingleItemMiddleware = getSingleItemMiddleware();
		return (buffersSerializer = new Serializer([
			new SingleItemMiddleware(),
			new (getObjectMiddleware())(context => {
				if (context.write) {
					/**
					 * @param {any} value value
					 */
					context.writeLazy = value => {
						context.write(
							SerializerMiddleware.createLazy(value, binaryMiddleware)
						);
					};
				}
			}, "md4"),
			binaryMiddleware
		]));
	}, 
	createFileSerializer: (fs, hashFunction) => {
		registerSerializers();
		const Serializer = getSerializer();
		const FileMiddleware = require("../serialization/FileMiddleware");
		const fileMiddleware = new FileMiddleware(fs, hashFunction);
		const binaryMiddleware = getBinaryMiddlewareInstance();
		const SerializerMiddleware = getSerializerMiddleware();
		const SingleItemMiddleware = getSingleItemMiddleware();
		return new Serializer([
			new SingleItemMiddleware(),
			new (getObjectMiddleware())(context => {
				if (context.write) {
					/**
					 * @param {any} value value
					 */
					context.writeLazy = value => {
						context.write(
							SerializerMiddleware.createLazy(value, binaryMiddleware)
						);
					};
					/**
					 * @param {any} value value
					 * @param {object=} options lazy options
					 * @returns {function(): Promise<any> | any} lazy function
					 */
					context.writeSeparate = (value, options) => {
						const lazy = SerializerMiddleware.createLazy(
							value,
							fileMiddleware,
							options
						);
						context.write(lazy);
						return lazy;
					};
				}
			}, hashFunction),
			binaryMiddleware,
			fileMiddleware
		]);
	}
};
