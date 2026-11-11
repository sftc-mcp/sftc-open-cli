/**
 * dsh 插件入口（Host 侧）。
 *
 * 这个 npm 包本身是一个「技能包」：SKILL.md 是给模型看的业务手册，scripts/clite.js 是
 * 真正干活的命令行。dsh 的组合包机制只负责「把插件行插进 profile 的插件树」，所以这里
 * 做一件最小但完整的事：把 SKILL.md 注册成 dsh 的原生技能（runtime skill），并把资源
 * 基目录指向本包根目录，模型拿到技能后就能按手册执行 `node scripts/clite.js ...`。
 *
 * 注册发生在 apply 里，随插件卸载自动回收（skills.register 返回的是 fiber effect）。
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 本包根目录（dsh/index.mjs 的上一级），作为技能的资源基目录。 */
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))

/** 技能名必须是 kebab-case，且在同一作用域内唯一。 */
const SKILL_NAME = 'sf-intra-city-skill'

/** 硬依赖 skills 服务：没有它就不要激活，避免装上了却不出现在技能目录里。 */
export const inject = ['skills']

export function apply(ctx) {
  const skillFile = join(packageRoot, 'SKILL.md')
  let raw
  try {
    raw = readFileSync(skillFile, 'utf8')
  } catch (error) {
    throw new Error(`sftc-open-cli: 读不到技能手册 ${skillFile}: ${error instanceof Error ? error.message : String(error)}`)
  }

  const { fields, body } = parseFrontmatter(raw)
  const description = fields.description || '顺丰同城急送：同城即时配送的询价、下单、支付、查单与取消。'

  ctx.skills.register({
    name: SKILL_NAME,
    description,
    whenToUse: '用户想在同城范围内寄送物品、询价、下单、支付、查单或取消订单时使用。',
    source: 'bundled',
    path: skillFile,
    // 技能正文 = SKILL.md 去掉 frontmatter 后的内容，模型看到的与包内文件一致。
    content: body,
    // 让模型知道脚本的真实绝对路径：手册里写的 scripts/clite.js 相对这里解析。
    resourceBase: { kind: 'directory', path: packageRoot },
    metadata: { package: 'sftc-open-cli', requires: { bins: ['node'] } },
  })
}

/**
 * 极简 frontmatter 解析：只认顶层 `key: value` 和其缩进续行（够读 name / description）。
 * 不引入 YAML 依赖，保持本包零依赖。
 *
 * @param text SKILL.md 原文
 * @returns fields 顶层字段；body 去掉 frontmatter 的正文
 */
function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(text)
  if (match === null) return { fields: {}, body: text }

  const fields = {}
  let current
  for (const line of match[1].split(/\r?\n/)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const top = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line)
    if (top !== null) {
      current = top[1]
      // `>-` / `|` 之类的块标量先当空值，由后续缩进行拼回来。
      fields[current] = /^[>|][-+]?$/.test(top[2]) ? '' : top[2].trim()
      continue
    }
    if (current !== undefined && /^\s+\S/.test(line)) {
      const piece = line.trim()
      fields[current] = fields[current] === '' ? piece : `${fields[current]} ${piece}`
    }
  }

  return { fields, body: text.slice(match[0].length).replace(/^\r?\n/, '') }
}
