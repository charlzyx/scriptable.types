const puppeteer = require('puppeteer');
const fs = require('fs');
const { exec } = require('child_process');

const typeConvert = (code) => {
  const ans = code
  .replace(/\n/, ';')
  .replace(/\[(.*)\]/g, m => {
    // 格式转换 Promise<[number]> -> Promise<number[]>
    const c = m.replace(/\[/, '').replace(/\]/, '')
    return c+'[]'
  })
  .replace('fn()', '() => void').replace(/fn\(.*\)/, m => {
    const c = m.replace('fn', '')
    return c + '=> void'
  })
  .replace('bool', 'boolean')
  return `  ${ans}`
}

const jsonToTs = (json) => {
  const isClazz = /^[A-Z]/.test(json.name);
  let prefix = '';
  if (isClazz) {
    prefix = `interface ${json.name} {`
  } else {
    prefix = `type ${json.name} = {`
  }
  let lines = [prefix];
  json.fields.forEach(p => {
    lines.push(`/** ${p.desc} */`)
    lines.push(typeConvert(p.code));
  })
  json.methods.forEach(p => {
    lines.push(`/** ${p.desc} */`)
    lines.push(typeConvert(p.code));
  })
  lines.push('}')
  lines.unshift(
`/** ---------${json.name} --------
  ${json.desc}
---------${json.name} --------
*/`)
  fs.writeFileSync('./api/' + json.name + '.ts', lines.join('\n'));
};

(async () => {
  const browser = await puppeteer.launch({
    args: [ '--proxy-server=http://127.0.0.1:7890' ],
    defaultViewport: { width: 1600, height: 1600 },
    // headless: false
  });
  const page = await browser.newPage();
  await page.goto('https://docs.scriptable.app/');

  // Get the "viewport" of the page, as reported by the page.
  const apiNames = await page.evaluate(() => {

    const list = Array.from(document.querySelectorAll('.md-sidebar--primary .md-nav__list > li'));
    // 移除第一个 Script Docs 大标题
    list.shift();

    return list.map(x => x.innerText).filter(x => !/\s+/.test(x));
  });
  console.log('apiNames', apiNames)

  for (apiName of apiNames) {
    console.log('loading....' + apiName)
    await page.goto('https://docs.scriptable.app/' + apiName.toLowerCase());
    const api = await page.evaluate(() => {
      const doc = {
        name: '',
        desc: '',
        fields: [],  // { name, desc, code }
        methods: []  // { name, desc, code }
      };
      const helper = {
        isTag:(el, tagName) => {
          return el.tagName.toLowerCase() === tagName.toLowerCase();
        },
        isCode: (el) => {
          return el.getAttribute('class') === 'codehilite';
        },
        splitBy: (arr, fn) => {
          return arr.reduce((result, cur, index) => {
            if (fn(cur, index)) {
              result.push([]);
            } else {
              result[result.length - 1].push(cur);
            }
            return result;
          }, [[]]).filter(x => x.length > 0)
        },
        parseTitle: (els)=> {
          /**解析大标题, 分离出来 props elements */
          while (els.length > 0) {
            const item = els.shift();
            const text = item.innerText.replace('¶', '');
            // h1 是大标题
            if (helper.isTag(item, 'h1')) {
              doc.name = text;
              // 遇到 h2 , 中断 title解析, 进入 props解析, 所以需要还回去 item
            } else if (helper.isTag(item,'h2')) {
              els.unshift(item);
              break;
              // 其他都解析到说明里
            } else {
              doc.desc += text;
            }
          }
          //将剩下的元素返回
          return els;
        },
        parseProp: (els) => {
          /**
           * 文档结构大概这样
           * h2: title
           * p+: 描述
           * code[class=codehilite]?: 示例代码
           * code[class=codehilite]: 类型代码
           * Parameters[id=parameters(.+)]: 参数类型
           * Return Value[id=return-value(.+)]: 返回类型
           */

          const prop = {
            name: '',
            desc: '',
            code: '',
            isMethod: false
          };

          // 第一个 h2 就是标题
          prop.name = els.shift().innerText.replace('¶', '');
          const hasFnDesc = els.find(x => /parameters|return/.test(x.getAttribute('id')));
          let fnDesc = [];
          els.reverse();
          if (hasFnDesc) {
            // 有函数定义的话,就先倒解析函数参数, 因为要保证 code 定义在最后一个 code 里面
            while (els.length > 0) {
              const item = els.shift();
              const text = item.innerText;
              // 如果是 code 那说解析完了, 回去
              if (helper.isCode(item)) {
                els.unshift(item);
                break;
              } else {
                fnDesc.push(text);
              }
            }
          }

          // 这时候第一位(反向的就是 code 了
          prop.code = els.shift().innerText;
          // 顺序反转回来, 剩下的都是注释
          els.reverse();
          // 倒解析的参数也反转回来
          fnDesc.reverse();
          prop.desc += els.map(x => x.innerText).join('');
          prop.desc += fnDesc.join('');
          // 根据类型注释中是否有括号来判断是不是方法
          prop.isMethod = /\(/.test(prop.code);
          return prop;
        },
        parseProps: (els) => {
          // 根据 hr tag 来分割属性/方法
          const props = helper.splitBy(els, x => helper.isTag(x, 'hr'))
          const docs = props.map(helper.parseProp)
          return docs;
        },
        parseDoc: (docEls) => {
          const propsEls = helper.parseTitle(docEls);
          const props = helper.parseProps(propsEls);
          props.forEach(prop => {
            if (prop.isMethod) {
              delete prop.isMethod;
              doc.methods.push(prop);
            } else {
              delete prop.isMethod;
              doc.fields.push(prop);
            }
          });
          return doc;
        }

      };
      const article = document.querySelector('.md-content__inner.md-typeset')
      const docEls = Array.from(article.children);
      return helper.parseDoc(docEls);
    });

    console.log(apiNames.findIndex(x => x.toLowerCase() === apiName.toLowerCase()) + ' / ' + apiNames.length + ' : ' + apiName)
    jsonToTs(api);
    // fs.writeFileSync('./api/' + apiName  + '.json', JSON.stringify(api, null, 2))
  }



  console.log('apiNames', apiNames)

  await browser.close();
})();
