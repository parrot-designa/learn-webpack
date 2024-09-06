const memoize = require('./memoize');

const getNum = memoize(() => require('./demo'));
const getConfigModule = memoize(() => require('./demo2'));

// 正常情况
console.log(getNum());

// 加载的初始化配置
// 下面2次打印出来的结果都是配置1；

// 初始化加载模块
const configModule1 = getConfigModule();
// 加载
// 初始化加载是 init为 false 打印出来 配置 1
console.log(configModule1());
// 初始化加载是 init为 true 打印出来 配置 2
console.log(configModule1());

// 再次加载模块
const configModule2 = getConfigModule();
// 由于文件缓存 init已经是 true了 所以打印出来配置 2
console.log(configModule2());
