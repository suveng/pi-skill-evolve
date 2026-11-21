/**
 * description 闸门：定位 + 长度。
 *
 * **description 的定位是「路由」，不是内容摘要**：它决定模型什么时候把这份技能加载进上下文，
 * 所以只写「什么时候用 + 触发词」，不写流程、不写实现、不复述正文。
 * 把正文摘要塞进 description 的后果不是「写得更全」，而是触发词被淹没、路由反而更差。
 *
 * 上限 1024 字，与 pi 的 Agent Skills 规范同一口径（`description.length`，中文按 1 字算）。
 * 超过上限 pi 会在加载期报 diagnostics（`description exceeds 1024 characters`），
 * 而 skill-evolve 的闸3 复验会因此回滚整份提案 —— 所以在提案校验阶段就先拦，别等写盘。
 */

/** 与 pi `dist/core/skills.js` 的 MAX_DESCRIPTION_LENGTH 保持一致 */
export const MAX_DESCRIPTION_LENGTH = 1024;

/** 建议留出的余量：刚好卡 1024 的提案，下一轮补一个触发词就会超限 */
export const DESCRIPTION_SOFT_LIMIT = 900;

/** 一句话说清「该怎么写」，既进提案校验的 detail，也进闸3 证据 */
export const DESCRIPTION_ADVICE =
	"description 是路由词，不是内容摘要：只写「什么时候使用 + 触发词」，不写流程、不复述正文；超限时删内容摘要、保留触发词，禁止继续追加";

export interface DescriptionValue {
	/** 取到的值；null = 没有 frontmatter 或没有 description 字段 */
	value: string | null;
	/** 值写成 `|` / `>` 块标量（多行），Skills 规范要求单行裸标量 */
	blockScalar: boolean;
	/** 值后面还有缩进续行（YAML 会把它们并进 description，等于折行） */
	multiline: boolean;
}

export interface DescriptionCheck {
	ok: boolean;
	/** 按 pi 同一口径算出的字符数（中文按 1 字） */
	length: number;
	/** 人话原因，直接进提案校验与闸3 证据 */
	detail: string;
}

/** 取 SKILL.md frontmatter 的 description；只认单行裸标量，块标量与折行都单独标出来 */
export function descriptionValueOf(text: string): DescriptionValue {
	const lines = text.split(/\r?\n/);
	if (lines[0]?.trim() !== "---") return { value: null, blockScalar: false, multiline: false };
	let end = -1;
	for (let index = 1; index < lines.length; index += 1) {
		if (lines[index].trim() === "---") {
			end = index;
			break;
		}
	}
	if (end < 0) return { value: null, blockScalar: false, multiline: false };

	let value: string | null = null;
	let at = -1;
	for (let index = 1; index < end; index += 1) {
		const match = /^description:\s*(.*)$/.exec(lines[index]);
		if (!match) continue;
		value = match[1].trim();
		at = index;
		break;
	}
	if (value === null) return { value: null, blockScalar: false, multiline: false };

	const blockScalar = /^[|>][+-]?$/.test(value);
	let multiline = false;
	if (!blockScalar) {
		for (let index = at + 1; index < end; index += 1) {
			const line = lines[index];
			if (line.trim().length === 0) continue;
			// 同级的 `key:` 行表示 description 到此结束；其余非空行都是续行
			if (/^[A-Za-z_-]+:\s*/.test(line)) break;
			multiline = true;
			break;
		}
	}
	return { value, blockScalar, multiline };
}

export function checkDescription(text: string): DescriptionCheck {
	const { value, blockScalar, multiline } = descriptionValueOf(text);
	if (value === null) return { ok: false, length: 0, detail: "frontmatter 缺 description（或没有 frontmatter）" };
	if (blockScalar) {
		return { ok: false, length: value.length, detail: `description 写成了块标量（${value}）：必须一行裸标量` };
	}
	if (multiline) {
		return { ok: false, length: value.length, detail: "description 折行了：必须一行裸标量（折行会让 YAML 把后续行并进描述）" };
	}
	const length = value.length;
	if (length > MAX_DESCRIPTION_LENGTH) {
		return {
			ok: false,
			length,
			detail: `description ${length} 字 > ${MAX_DESCRIPTION_LENGTH} 上限（超 ${length - MAX_DESCRIPTION_LENGTH} 字）。${DESCRIPTION_ADVICE}`,
		};
	}
	return { ok: true, length, detail: `description ${length} 字，在 ${MAX_DESCRIPTION_LENGTH} 上限内` };
}
