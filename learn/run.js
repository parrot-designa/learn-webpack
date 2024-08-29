const webpack = require('../lib/webpack.js');
const webpackConfig = require('./webpack.config');  

const compiler = webpack(webpackConfig); 

compiler.run();