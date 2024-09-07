// 同步的钩子
const { SyncHook } = require('tapable');

class SyncDemo {
    constructor(){
        // 吃早餐
        this.eatBreakfast = new SyncHook();
    }
}

let asyncInstance = new SyncDemo();

asyncInstance.eatBreakfast.tap('吃早餐',()=>{
    console.log('吃第一次早餐'); 
    let price = 0;
    for(let i = 0; i < 1000000000;i++){
        price += 1;
    }
    console.log('花了'+price + '元'); 
    return price;
})
asyncInstance.eatBreakfast.tap('吃早餐',()=>{
    console.log('吃第二次早餐');
    console.log('花了'+price + '元'); 
    return price;
})
asyncInstance.eatBreakfast.tap('吃早餐',()=>{
    console.log('吃第三次早餐');
    console.log('花了'+price + '元'); 
})

module.exports = asyncInstance;