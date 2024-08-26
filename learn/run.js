const webpack = require('../lib/webpack.js');
const webpackConfig = require('./webpack.config');


const compiler = webpack(webpackConfig);

console.log(111)

compiler.run((err,stats)=>{
    console.log("===end==>",err);
})