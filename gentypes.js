const puppeteer = require('puppeteer')
const fs = require('fs')

const typeConvert = (code) => {
  const ans = code
  // \n -> ;
    .replace(/\n/, ';')
  // Promise<[number]> -> Promise<number[]>
    .replace(/\[(.*)\]/g, m => {
      const c = m.replace(/\[/, '').replace(/\]/, '')
      return c + '[]'
    })
  // fn() -> () => void
    .replace('callback: fn()', 'callback: () => {}')
    .replace(': fn(', ' fn(')
    .replace('fn(string)', '(str: string)')
    .replace('fn(string, {string: string})', '(msg: string, info: Record<string, string>)')
    .replace('fn(number)', '(selected: number)')
  // fn(....) => (....) => void
    .replace('fn(Request) ->', '(req: Request): ')
    .replace('fn()', '()')
  // bool -> boolean
    .replace('bool', 'boolean')
    .replace('{string: string}', 'Record<string, string>')
    .replace('{string: number}', 'Record<string, number>')
    .replace('{string: any}', 'Record<string, any>')
  // new Xxxxx(...) -> (...) => void
    .replace(/new\s.*\(/, m => {
      return 'constructor('
    })
    .replace('Promise;', 'Promise<void>')
  return `  ${ans}`
}

const jsonToTs = (json) => {
  const isClazz = /^[A-Z]/.test(json.name) || json.name === 'console'
  let prefix = ''
  if (isClazz) {
    prefix = `  class ${json.name} {`
  } else {
    prefix = `  const ${json.name} : {`
  }
  const lines = [prefix]
  json.fields.forEach(p => {
    lines.push(`\n  /**
${'  * ' + p.desc.replace(/\n/g, m => '\n  * ')}
  */`)
    lines.push(typeConvert(p.code))
  })
  json.methods.forEach(p => {
    lines.push(`\n  /**
${'  * ' + p.desc.replace(/\n/g, m => '\n  * ')}
  */`)
    lines.push(typeConvert(p.code))
  })
  lines.push('}')
  lines.unshift(
    `/** ---------${json.name} --------
  ${json.desc}
---------${json.name} --------
*/`)
  fs.appendFileSync('./typings/global.d.ts', lines.join('\n'))
  // fs.writeFileSync('./typings/' + json.name + '.d.ts', lines.join('\n'));
};

(async () => {
  const browser = await puppeteer.launch({
    // args: [ '--proxy-server=http://127.0.0.1:7890' ],
    defaultViewport: { width: 1600, height: 1600 }
    // headless: false
  })
  const page = await browser.newPage(); await page.goto('https://docs.scriptable.app/')

  // Get the "viewport" of the page, as reported by the page.
  const apiNames = await page.evaluate(() => {
    const list = Array.from(document.querySelectorAll('.md-sidebar--primary .md-nav__list > li'))
    // 移除第一个 Script Docs 大标题
    list.shift()

    return list.map(x => x.innerText)
      .filter(x => !/\s+/.test(x))
  })
  console.log('apiNames', apiNames)
  if (!fs.existsSync('./typings')) {
    fs.mkdirSync('./typings')
  }
  fs.writeFileSync('./typings/global.d.ts', 'export {}; \ndeclare global {\n')

  for (apiName of apiNames) {
    console.log('loading....' + apiName)
    await page.goto('https://docs.scriptable.app/' + apiName.toLowerCase())
    const api = await page.evaluate(() => {
      const doc = {
        name: '',
        desc: '',
        fields: [], // { name, desc, code }
        methods: [] // { name, desc, code }
      }
      const helper = {
        isTag: (el, tagName) => {
          return el.tagName.toLowerCase() === tagName.toLowerCase()
        },
        isCode: (el) => {
          return el.getAttribute('class') === 'codehilite' && el.innerText.split('\n').length <= 2
        },
        yankCode: (els) => {
          const idx = els.findIndex(x => helper.isCode(x))
          let code = ''
          if (idx > -1) {
            const found = els.splice(idx, 1)
            code = found[0]
          }
          return code || { innerText: '' }
        },
        splitBy: (arr, fn) => {
          return arr.reduce((result, cur, index) => {
            if (fn(cur, index)) {
              result.push([])
            } else {
              result[result.length - 1].push(cur)
            }
            return result
          }, [[]]).filter(x => x.length > 0)
        },
        parseTitle: (els) => {
          /** 解析大标题, 分离出来 props elements */
          while (els.length > 0) {
            const item = els.shift()
            const text = item.innerText.replace('¶', '')
            // h1 是大标题
            if (helper.isTag(item, 'h1')) {
              doc.name = text
              // 遇到 h2 , 中断 title解析, 进入 props解析, 所以需要还回去 item
            } else if (helper.isTag(item, 'h2')) {
              els.unshift(item)
              break
              // 其他都解析到说明里
            } else {
              doc.desc += text + '\n'
            }
          }
          // 将剩下的元素返回
          return els
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
          }

          // 第一个 h2 就是标题
          prop.name = els.shift().innerText.replace('¶', '')
          const hasFnDesc = els.find(x => /parameters|return/.test(x.getAttribute('id')))
          const fnDesc = []
          els.reverse()
          if (hasFnDesc) {
            // 有函数定义的话,就先倒解析函数参数, 因为要保证 code 定义在最后一个 code 里面
            while (els.length > 0) {
              const item = els.shift()
              const text = item.innerText
              // 如果是 code 那说解析完了, 回去
              if (helper.isCode(item)) {
                els.unshift(item)
                break
              } else {
                fnDesc.push(text)
              }
            }
          }

          // 抽取 code 内容了
          prop.code = helper.yankCode(els).innerText
          // 顺序反转回来, 剩下的都是注释
          els.reverse()
          // 倒解析的参数也反转回来
          fnDesc.reverse()
          prop.desc += els.map(x => x.innerText).join('\n')
          prop.desc += fnDesc.join('\n')
          // 根据类型注释中是否有括号和是否包含 fn来判断是不是方法
          prop.isMethod = /\(/.test(prop.code)
          return prop
        },
        parseProps: (els) => {
          // 根据 hr tag 来分割属性/方法
          const props = helper.splitBy(els, x => helper.isTag(x, 'hr'))
          const docs = props.map(helper.parseProp)
          return docs
        },
        parseDoc: (docEls) => {
          const propsEls = helper.parseTitle(docEls)
          const props = helper.parseProps(propsEls)
          props.forEach(prop => {
            if (prop.isMethod) {
              delete prop.isMethod
              doc.methods.push(prop)
            } else {
              delete prop.isMethod
              doc.fields.push(prop)
            }
          })
          return doc
        },
        reformatimportModule: (article, docEls) => {
          const name = article.querySelector('h1').innerText.replace('¶', '');
          const codeEl = docEls.find(x => x.getAttribute('class') === 'codehilite');
          if (name === 'importModule') {
            return {
              name: 'importModule',
              code: codeEl.innerText,
            }
          }
        }
      }
      const article = document.querySelector('.md-content__inner.md-typeset')
      const docEls = Array.from(article.children)
      // importModule 跟别人都不一样, 需要特殊处理
      return helper.reformatimportModule(article, docEls) || helper.parseDoc(docEls)
    })

    console.log(apiNames.findIndex(x => x.toLowerCase() === apiName.toLowerCase()) + ' / ' + apiNames.length + ' : ' + apiName)

    if (api.name === 'importModule') {
      const code = api.code.replace(/importModule(.*)/, m => {
        return '\n\n  const importModule: ' + m.replace('importModule', '') + ' => void;'
      });
      fs.appendFileSync('./typings/global.d.ts', code)
    } else {
      jsonToTs(api)
    }
    // fs.writeFileSync('./api/' + apiName  + '.json', JSON.stringify(api, null, 2))
  }
  fs.appendFileSync('./typings/global.d.ts', '} \n')

  console.log('apiNames', apiNames)

  await browser.close()
})()
