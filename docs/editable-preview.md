# 可编辑富文本预览（Editable Preview）设计文档

> 状态：**P0–P4 全部完成**——草稿视图可编辑、可保存，支持值编辑、页眉页脚配置与块级结构编辑。
> 已知不做：插入图片、段落内 run 的增删（理由见 §3.8）。
> 相关模块：`src/nodePath.js`、`src/htmlUtil.js`、`src/transform.js`、`src/normalize.js`、`src/service.js`、`playground/`

## 1. 背景与目标

现在 Playground 的预览链路是 `docx → LibreOffice → PDF → pdftoppm → PNG`（`playground/server.js:47-61`），产出是**静态图片**。三个问题：慢、强依赖 LibreOffice + poppler、客户看到错别字只能回头让 agent 重跑一次工具调用。

目标是在渲染成 DOCX 之前（或渲染的同时）给客户一份**可编辑的富文本视图**，让客户直接改文字和数值，改动同步回 def，再重新渲染。

### 范围

| | 状态 |
|---|---|
| 改正文文字、数值 | ✅ P0–P3 |
| 改图题表题、checklist 条目 | ✅ P0–P3 |
| 页眉页脚配置 | ✅ P3b |
| 整节点增 / 删 / 上下移 | ✅ P4 |
| 自动编号 / 交叉引用 / TOC | 🔒 只读，保持只读 |
| 插入图片 | ❌ 需先有图片上传通道（§3.8） |
| 段落内 run 的增删 | ❌ 下标耦合风险 + 无自然操作入口（§3.8） |
| 改样式、字体、版式 | ❌ 不做（属确定性代码的职责） |

### 定位：草稿视图，不是 WYSIWYG

**不追求像素级还原 Word。** 分页、页眉页脚、浮动图、公式在浏览器里对不齐，追这个是无底洞。最终形态是两个 tab：

- **编辑视图**（HTML，即时，无外部依赖）—— 改内容用这个
- **版式视图**（现有 PNG 分页图）—— 确认最终长相用这个

附带收益：HTML 视图不依赖 LibreOffice，等于给「没装 LibreOffice 的用户看不到任何预览」兜了底。

## 2. 现状核验（2026-07-29 实测）

### 2.1 transform 输出的节点 id 是残缺的

输入 def：

```js
{ meta:{autoNumber:true}, contexts:[
  {id:"h1",  type:"heading", level:1, text:"概述"},
  {id:"p1",  type:"text",    text:"如 {{ref:t1}} 所示，温度为 82.6 度。"},
  {id:"t1",  type:"table",   caption:"实测数据", data:[...]},
  {id:"img1",type:"image",   caption:"现场照片", path:"x.png"},
  {id:"ck1", type:"checklist", items:["第一项","第二项"]},
]}
```

`transform(def, {})` 实际输出：

```
0 {id:"h1",   type:"heading", text:"1 概述"}
1 {id:"p1",   type:"text",    text:"如 表1 所示，温度为 82.6 度。"}
2 {id:null,   type:"text",    text:"表1 实测数据"}      ← 表题，id 丢失
3 {id:"t1",   type:"table"}
4 {id:"img1", type:"image"}
5 {id:null,   type:"text",    text:"图1 现场照片"}      ← 图题，id 丢失
6 {id:null,   type:"text",    text:" 第一项"}           ← ck1 整个消失
7 {id:null,   type:"text",    text:" 第二项"}
```

分三类：

**A 类｜id 保留，但文本被污染**
- `heading`（`transform.js:139-141`）：`text` 被前缀成 `"1 概述"`，编号和标题文字揉进同一字符串。
- `text`（`transform.js:146`）：`{{ref:t1}}` 已被替换成字面量 `表1`。用户直接编辑这段，引用标记永久丢失，后续表格顺序变化时引用不再更新。

**B 类｜id 丢失，但内容属于用户** ← 核心问题
- 表题（`transform.js:154`）、图题（`transform.js:173`）经 `makeCaptionNode` 产出**匿名 text 节点**。图题表题是模型/用户写的内容，客户改它的概率很高，但改完无法定位回 def。
- checklist（`transform.js:182-190`）展开成 N 个匿名 text 节点，原节点 `ck1` 在输出中完全不存在。

**C 类｜id 丢失，内容本就由系统生成**
- TOC 条目（`transform.js:209-223`）。无所谓，本就该只读。

**结论：「渲染后视图 → 定位回 def」当前走不通，必须先补溯源信息。**

### 2.2 两条已验证的前置条件

- **`docxUtil` 容忍节点上的未知字段。** 给 heading/text 节点挂 `_src` 后调用 `report(def)` 正常返回，无报错。→ `_src` 可以直接透传到渲染层，不必强制在服务层剥离。
- **`validator.validate()` 不拒绝未知字段。** 带伪造 `_src` 的输入 def 校验返回 `[]`。→ **客户端可以伪造 `_src`**，所以服务层必须在入口剥离外部传入的 `_src`，保证溯源信息只可能由 `transform` 产生。这是 P0 的一条硬性要求。

## 3. 设计

### 3.1 地基：transform 产出 provenance（`_src`）

`transform` 是纯函数，给每个输出节点附加 `_src` 溯源字段，**纯加法，不改变现有渲染行为**。

```ts
_src = {
  id: string,              // 写回目标 def 节点的稳定 ID
  readonly?: true,         // 整节点不可编辑（TOC 条目等纯生成物）
  overrides?: Override[],  // 见 3.3；仅列出「渲染值 ≠ def 原值」的叶子
}

Override = {
  at?: Segment[],    // 输出节点侧的叶子位置；缺省等同 path
  path: Segment[],   // def 节点侧的写回路径，见 3.2
  raw?: string,      // 编辑基准值：def 中未经 ref 替换的原始字符串
  prefix?: string,   // 由系统计算、渲染在该叶子前的只读片段
}
```

**`at` 与 `path` 分离**是必要的：派生节点在输出里的位置和它在 def 里的来源位置不是同一条路径。图题在输出中是一个 text 节点的 `["text"]`，但要写回的是 image 节点的 `["caption"]`。只有一条 `path` 表达不了这层映射。两者相同时（heading、text 这类原位改写）省略 `at`。

**一个输出节点可以包含多个可编辑叶子**（多 run 段落、表格的每个单元格），所以溯源信息必须是「节点 ID + 叶子路径列表」，而不是单个 `field`。这是本设计最容易做错的地方。

各节点类型的 `_src` 实例：

| 输出节点 | `_src` |
|---|---|
| heading（`transform.js:139`） | `{ id:"h1", overrides:[{ path:["text"], raw:"概述", prefix:"1 " }] }` |
| text 单 run（含 ref） | `{ id:"p1", overrides:[{ path:["text"], raw:"如 {{ref:t1}} 所示，温度为 82.6 度。" }] }` |
| text 多 run（含 ref） | `{ id:"p2", overrides:[{ path:["text",1], raw:"见 {{ref:img1}}" }] }` —— 只列受影响的 run |
| text 无 ref | `{ id:"p3" }` —— 无 override，全部叶子按恒等处理 |
| table | `{ id:"t1" }` —— transform 不改单元格内容，全恒等 |
| 表题 | `{ id:"t1", overrides:[{ at:["text"], path:["caption"], raw:"实测数据", prefix:"表1 " }] }` |
| 图题 | `{ id:"img1", overrides:[{ at:["text"], path:["caption"], raw:"现场照片", prefix:"图1 " }] }` |
| checklist 项（字符串形） | `{ id:"ck1", overrides:[{ at:["text"], path:["items",0], prefix:" " }] }` |
| checklist 项（对象形） | `{ id:"ck1", overrides:[{ at:["text"], path:["items",0,"text"], prefix:" " }] }` |
| TOC 条目 / 其他生成物 | `{ readonly:true }` |

**恒等默认（identity default）**：对**原位节点**（输出节点与 def 节点同类同构：text、heading、table、image），`overrides` 只列出被 transform 改写过的叶子；未列出的可编辑叶子按 `raw === 渲染值`、`prefix === ""`、`at === path` 处理。这样表格这类大节点不会因为溯源而膨胀。

**派生节点**（图题、表题、checklist 展开项——由 transform 新建、def 里没有对应节点的输出节点）**必须逐叶子显式给出 override**，不适用恒等默认。它们的输出形态与 def 形态不同构，缺了 override 就无法定位写回目标。

**无 `_src` 即只读**：这是安全默认。渲染器遇到没有 `_src` 的输出节点一律不给编辑，不去猜。

有了它，HTML 渲染器对每个叶子都能判定三件事：哪些字符是系统算的、哪些可编辑、改完写回哪个节点的哪条路径。**「系统生成的不能动」从此有机器可判定的依据**，而不是靠前端硬编码猜测。

### 3.2 路径规范（Segment Path）

#### 3.2.1 表示形式

路径的**规范形是段数组**，不是点分字符串：

```js
["data", 0, "texts", 2, 1]        // ✅ 规范形
"data[0].texts[2][1]"             // 仅用于日志与测试快照的展示形，不参与解析
```

理由：字符串路径需要解析器和转义规则，是这类实现的经典 bug 源。段数组无需解析、无歧义、无转义。展示形由一个纯函数单向生成，**不允许反向解析回段数组**。

`Segment` 只允许两种类型：

- `string` —— 对象键
- `number` —— 数组下标，必须是非负整数

#### 3.2.2 可编辑叶子白名单

**白名单制：只有下表列出的路径可编辑，其余一律只读。** 黑名单在这里不安全——新增节点类型时会默认变成可写。

| def 节点 | 数据形态 | 可编辑叶子路径 |
|---|---|---|
| `text` | `text` 为字符串 | `["text"]` |
| `text` | `text` 为数组（多 run） | `["text", i]` 逐 run |
| `text` | `textOptions` 为对象 | `["textOptions","footnote"]`、`["textOptions","comment"]` |
| `text` | `textOptions` 为数组 | `["textOptions", i, "footnote"]`、`["textOptions", i, "comment"]` |
| `heading` | `text` 为字符串 | `["text"]` |
| `heading` | `text` 为数组 | `["text", i]`（此时 transform 不加编号前缀，见 `transform.js:139`） |
| `image` | — | `["caption"]` |
| `table` | 单元格为字符串 | `["data", r, "texts", c]` |
| `table` | 单元格为数组（格内多行） | `["data", r, "texts", c, k]` |
| `table` | 单元格为对象（格级样式） | `["data", r, "texts", c, "text"]` |
| `table` | 单元格为对象且 `text` 为数组 | `["data", r, "texts", c, "text", k]` |
| `table` | — | `["caption"]` |
| `checklist` | 条目为字符串 | `["items", i]` |
| `checklist` | 条目为对象 | `["items", i, "text"]` |

不可编辑（一期）：`textOptions` 的样式字段（`bold`/`size`/`font`/`style`/`link`/`checkbox`/`math`）、`paragraphOptions` 全部、`tableOptions` 全部、`columnWidths`、`level`、`type`、`id`、`float`、`src`/`path`、`math` 节点整体、`meta` 全部。

单元格三形态源自 `normalize.js:14-21`：`normalizeCell` 保留字符串、数组、`{text}` 对象三种形，存储层不会把它们统一掉，所以路径规范必须三种都覆盖。

#### 3.2.3 写回解析器语义

写回是「**定位既有叶子并替换**」，不是「按路径创建结构」。一期只做值编辑，这条限制让解析器既简单又安全：

1. 逐段下行；任一段不存在 → **拒绝**（不创建中间结构）。
2. 段类型必须与容器匹配：数组容器只接受非负整数段且需在界内；对象容器只接受字符串段。
3. 目标叶子的当前值**必须是字符串**；否则拒绝（防止把子树替换成标量）。
4. 新值必须是字符串。
5. 段黑名单：`__proto__`、`constructor`、`prototype` 一律拒绝（原型污染防护）。
6. 路径必须命中 3.2.2 白名单；不在白名单内即使存在也拒绝。
7. 写入走**不可变更新**（逐层浅拷贝），不原地改 def。

任一条不满足即整次写回失败并返回结构化错误，不做部分写入。

#### 3.2.4 多 run 段落的编辑隔离

多 run 段落（`examples/demo-report.js:29-31` 那种混排）是一期最容易出问题的形态。规则：

- HTML 中**每个 run 渲染为独立的可编辑 span**，各自带自己的路径。
- **每个 run 是一座编辑孤岛**：跨 run 边界的选区删除、粘贴、输入一律被阻止或钳制到单个 run 内。
- 不允许用户新增/删除 run——P4 的块级结构编辑也没开这一项，理由见 §3.8。

不做隔离的后果：用户跨越加粗边界一拖一删，三个 run 塌成一个，混排样式永久丢失，且写回时无法判定该改哪条路径。

#### 3.2.5 run 与 textOptions 的下标耦合

`text[i]` 与 `textOptions[i]` 是**按下标一一对应**的两个平行数组。因此：

- 编辑 `["text", 1]` 不影响 `["textOptions", 1]`，反之亦然——两者是同一 run 的正文与附注，互不干扰。
- 禁止增删 run，两数组长度恒定，下标对应关系在整个编辑会话中稳定。
- 这条耦合正是 §3.8 不开放 run 级增删的原因：增删 run 必须同步维护两个数组，错一格样式与脚注会整体错位。P4 因此只做块级。

### 3.3 锁定 chip：`{{ref:}}` 与编号

一期唯一的真难点。段落 `p1` 在编辑器中呈现为：

```
如 [表1] 所示，温度为 82.6 度。
   ↑ contenteditable=false 的灰色 chip，光标跳过
```

可编辑文本与只读 chip 混排。提交时按 DOM 顺序重建该叶子的字符串，chip 还原成 `{{ref:t1}}`——还原的依据是 `_src.overrides` 里该路径的 `raw`，不是前端猜测。heading 的编号前缀、图题表题的 `图1 ` / `表1 ` 前缀同理，来自同一条 override 的 `prefix`。

用户能把 `82.6` 改成 `83.1`，但删不掉也改不了 `表1`。

**`{{pageRef:}}` 同样锁定**：它不被 transform 解析（页码域由渲染层出），会以字面量停在正文里。不锁的话它就是可编辑区里一串能被改坏的原文，所以 `htmlUtil` 直接从渲染值里把它切成只读 chip，显示为「页码」——草稿视图没有分页，没有真页码可显示。

**提交前校验（服务端，`service.updateNodeValue`）**：新值里 `{{ref:}}` / `{{pageRef:}}` 标记的**类型、id、相对顺序**必须与库中现值完全一致，否则整次写回被拒。两种标记合起来扫一遍（`validator.markerFingerprint`），按类型分开收集会丢掉相对次序。

这条校验**独立于前端**，不是前端 chip 锁定的复述——绕过页面直接打 API 是常态，前端防线不能作数。增删改引用是结构操作，走 `update_node`。

**切分实现（`htmlUtil.splitLeaf`）**：渲染值 = `prefix + resolve(raw)`，切分时拿 `raw` 里的 `{{ref:}}` 标记与渲染值做同步走位，切出每个 ref 实际被替换成的标签文字。两种情况放弃切分、整条叶子降级为只读：

- 前缀与渲染值对不上；
- 两个 ref 紧挨着（`{{ref:a}}{{ref:b}}` → `表1图2`，边界无从判定）。

降级只损失可编辑性，绝不会切错边界写坏 def——失败方向朝安全侧倒。

### 3.4 写回不新开入口

编辑器**只是 service 层的又一个客户端**，与 MCP agent 共用同一套写入口和 validator：

```
DOM → 按 _src 归并出 { id, path, value } → 3.2.3 解析器 → 现有 update 路径（service.js:530 附近）→ validator
```

不新建平行写路径，保证「无效输入在边界被拒绝」这条架构不变量成立。

现有 update 走的是整节点替换（`normalizeNode({ ...node, id })`）。**路径级写回在服务层内部先把 `{ id, path, value }` 解析成完整的新节点，再交给既有落库+校验路径**，因此不改动 update 的对外契约。

P3 实现为 `service.updateNodeValue({ docId, id, path, value })`，链路：

```
失焦 → 按 DOM 顺序重建叶子字符串（chip 还原成 {{ref:id}}）
     → POST /api/docs/:docId/draft
     → MCP update_node_value（UI_ONLY，不进模型工具表）
     → 标记一致性校验 → nodePath.writePath → normalizeNode → store → validator
```

前端传的是**规范段数组**，不是展示形——`data-path` 是给人看的，回传用 `data-path-json`。展示形单向不可解析（§3.2.1），所以渲染器两个属性都出。

`update_node_value` 与 `get_draft_html` 一样是 UI 窄口：模型改内容用 `update_node`（整节点替换），路径级值编辑是给人工编辑界面用的。

### 3.5 页眉页脚：文档级 / 节级配置通道

页眉页脚不走正文那套内联编辑，而是一个**独立的配置面板**。原因：它是文档级/节级属性，不在正文流里；且字段类型是布尔和对象，套不进 §3.2.3 只认字符串叶子的解析器。

#### 3.5.1 两个作用域

有效配置由 `sectionConfigOf`（`docxUtil.js:133-152`）合并而成：`节级字段 !== undefined ? 节级 : meta`。

| 作用域 | 载体 | 寻址方式 |
|---|---|---|
| 文档级 | `def.meta` | **无节点 ID**，需要文档级写回通道 |
| 节级 | `sectionBreak` 节点 | **复用现有节点 ID + 路径寻址**，无需新机制 |

`sectionBreak` 是 `contexts` 里的普通节点，有稳定 ID。所以节级覆盖只是又一组白名单路径（`["headerText"]` 等），走 §3.4 的既有 update 通道即可。**真正需要新通道的只有 `meta` 这一层。**

#### 3.5.2 可配置字段白名单

| 字段 | 类型 | 文档级 | 节级 | 备注 |
|---|---|---|---|---|
| `headerText` | string | ✅ | ✅ | 空字符串 = 整节无页眉，语义不同于未设置 |
| `pageNumber` | bool | ✅ | ✅ | 页脚「第x页 共x页」 |
| `titlePage` | bool | ✅ | ✅ | 首节取 `meta`；后续节不给则恒为 `false`（`docxUtil.js:147`） |
| `pageNumberStart` | number | ❌ | ✅ | **不继承**，仅节点显式给才重启（`docxUtil.js:144`） |
| `pageNumberFormat` | string | ❌ | ✅ | 同上，只从节点取 |
| `headerImage` / `footerImage` | object | ⚠️ | ⚠️ | 见 3.5.4，一期不开放 |
| `headerSize` / `font` | — | ❌ | ❌ | 样式参数，属 preset 职责，不给客户改（`docxUtil.js:148-150`） |
| `landscape` / `margins` / `columns` | — | ❌ | ❌ | 版式参数，一期不开放 |

#### 3.5.3 继承三态：`undefined` ≠ `""`

**这是本节最容易做错的地方。** `pick` 用 `!== undefined` 判定，所以：

- `headerText: undefined` → 继承文档级
- `headerText: ""` → **显式声明本节无页眉**，不继承
- `headerText: "报告编号 IP-2026-001"` → 本节用该文字

UI 必须呈现为三态，而不是一个普通输入框：

```
页眉文字   ( • ) 继承文档级：「InkPaw 演示报告」
           ( ) 本节无页眉
           ( ) 自定义：[____________]
```

「继承」选项写回时必须**删除该键**，而不是写空字符串——写成 `""` 会静默变成「本节无页眉」，客户看到页眉消失却找不到原因。同理，清除覆盖是 `delete`，不是置空。

`pageNumberStart` / `pageNumberFormat` 没有继承态（只有「不设置」和「设置」两态），UI 不显示继承选项。

#### 3.5.4 写回契约

文档级配置**不能复用 §3.2.3 的字符串解析器**，它需要自己的类型化校验：

1. 字段必须命中 3.5.2 白名单，且作用域匹配（`pageNumberStart` 不接受文档级写入）。
2. 值类型必须与白名单声明一致；`null` 一律拒绝。
3. 「继承」语义走删除键，不走赋值。
4. 节级写回落到该 `sectionBreak` 节点，复用 §3.4 的既有 update；文档级写回是一条新的 `update_meta` 服务方法。
5. **`headerImage` / `footerImage` 一期不开放客户编辑**：其 `src` 是文件路径，而受限作用域的服务会拒绝服务端路径输入（见 `docs/architecture.md` 的 HTTP 安全与隔离一节）。开放它等于给编辑器开一条路径注入面，需要先接入既有的图片上传通道再单独设计。

#### 3.5.5 预览呈现

HTML 编辑视图**不渲染页眉页脚**——它是草稿视图，没有分页概念，画一条页眉反而误导。配置面板改完后，客户到版式视图（PNG）确认真实效果。这与 §1「草稿视图不是 WYSIWYG」的定位一致。

### 3.6 Playground 接线（P2 实现）

草稿 HTML 的生成必须走**和渲染同一条 transform**：编号、图表号、`{{ref:}}` 解析结果要与 DOCX 完全一致，否则客户在草稿里看到的编号和最终文档对不上。所以它由服务层出（`service.getDraftHtml`），不由前端拼。

Playground 只经 MCP 与 InkPaw 通信，零 `src/` 直接依赖（`playground/mcp-bridge.js` 的既有约定），因此草稿走 MCP 工具 `get_draft_html`：

```
浏览器 → GET /api/docs/:docId/draft → Playground 服务端
       → MCP get_draft_html → service.getDraftHtml → transform + htmlUtil
```

两处必要的特殊处理：

- **UI 工具不进模型工具表。** `get_draft_html` 是人工审阅界面的能力，不是 agent 动作。`mcp-bridge.js` 的 `UI_ONLY_TOOLS` 把它从 `openaiTools` 里滤掉——摆给模型只会占上下文并诱发无用调用；Playground 自己仍可直接 `callTool`。
- **UI 调用不截断。** `callTool` 默认 20000 字符截断是为保护模型上下文；草稿 HTML 不进模型，截断只会让页面残缺，所以走 `{ truncate: false }`。

### 3.7 前端编辑约束（P2 实现）

`.ip-leaf` 是 contenteditable 容器，chip 是其中 `contenteditable="false"` 的子元素。仅靠这个属性不够——拖放、IME、undo 都能绕过。实际是三层防护：

1. **`beforeinput` 拦截**：用 `getTargetRanges()` 判定本次输入的影响范围。命中任一条即 `preventDefault`——影响范围碰到 chip、范围越出本叶子（§3.2.4 编辑孤岛）、输入类型是 `insertParagraph`/`insertLineBreak`（换行属结构编辑，P4）。
2. **粘贴与拖放**：粘贴一律降级为纯文本并压掉换行（富文本会把整片 span 和样式带进叶子）；`drop`/`dragstart` 直接禁用——拖放能绕过 `beforeinput` 把 chip 搬走。
3. **`input` 事后兜底**：比对 chip 指纹（ref id 的有序列表）。变了就把整条叶子还原成初始快照并提示用户。宁可丢一次输入，也不写坏引用。

第 1 层拦不住的浏览器差异由第 3 层收口。这是 §3.3「提交前校验」在前端的前置防线，P3 的服务端校验仍然独立成立——前端防护不能替代服务端校验。

### 3.8 块级结构编辑（P4 实现）

`updateDraftStructure({ docId, op, anchorId, text })` 是收窄的 UI 通道，转调既有的 `insertNodes` / `deleteNodes` / `moveNodes`——id 分配、引用悬空扫描、校验全部沿用原有逻辑，不新开写路径。

支持的 op：`insertBefore`、`insertAfter`（只插普通段落）、`delete`、`moveUp`、`moveDown`。

**一个 def 节点可能渲染成多个块**（表格 = 表题段 + 表 body，checklist = 每项一段）。前端按 `data-node-id` 去重，只在该 id 的第一个块上挂控件，否则一个节点会出现多套按钮，且删除语义会让用户误解为「只删这一段」。

删除被引用的节点**不阻止但要点名**：`deleteNodes` 返回的 `delete-ref-broken` warning 会推给用户。删除是用户的正当权利，但文档已经带伤，静默通过等于把问题留到渲染时才炸。

#### 明确不做的两项

**插入图片。** `src` 是文件路径，开放等于给编辑器开一条路径注入面（同 §3.5.4 对 `headerImage` 的判断）。要做得先接图片上传通道，再单独设计。

**段落内 run 的增删。** `text` 与 `textOptions` 是按下标一一对应的平行数组（§3.2.5），增删 run 必须同步维护两者，错一格样式和脚注会整体错位。而且页面上没有「这是第几个 run」的自然操作入口——用户看到的是连续文字，不是三个格子。真要做，需要先设计 run 的可视边界，属独立议题。

值编辑仍然覆盖这两类内容：图片的 `caption` 可改，每个 run 的文字可改——不能改的只是它们的**数量**。

## 4. 分阶段实施

| 阶段 | 内容 | 验收标准 |
|---|---|---|
| **P0a** ✅ | 路径解析器：白名单校验 + 读写（3.2.2 / 3.2.3）→ `src/nodePath.js` | 纯函数、独立单测；覆盖表格三种单元格形态、多 run、checklist 两种条目形态；越界/类型不符/原型污染/非白名单路径全部被拒 |
| **P0b** ✅ | `transform` 产出 `_src` → `src/transform.js` | 单测覆盖 2.2 中 A/B/C 三类节点；恒等默认生效（无 ref 的 text、table 不产生 overrides）；现有 transform 测试全绿 |
| **P0c** ✅ | 入口剥离外部传入的 `_src` → `src/normalize.js` | 伪造 `_src` 的输入 def 存库后不含 `_src` |
| **P1** ✅ | `src/htmlUtil.js`：def → HTML，协议无关 | 与 `docxUtil` 平行的第二后端，不依赖 MCP/SQLite/LibreOffice；每个可编辑叶子带 `data-node-id` + `data-path`（展示形） |
| **P2** ✅ | Playground 编辑视图 tab + chip 锁定 + run 隔离 | 与现有 PNG 版式视图并存；只读片段光标跳过、无法删改；跨 run 选区编辑被钳制 |
| **P3** ✅ | 写回：DOM → `{id, path, value}` → 解析器 → 现有 update → validator | 改文字/数值后重渲染，改动持久化；ref 与编号在重渲染后自动更新；3.3 的 chip 一致性校验生效 |
| **P3b** ✅ | 页眉页脚配置面板 + `getDocConfig`/`updateDocConfig`（3.5） | 三态继承 UI 正确；选「继承」写回是删除键而非置空；节级覆盖走既有 update；`pageNumberStart` 拒绝文档级写入 |
| **P4** ✅ | 块级结构编辑：整节点增/删/上下移 | 转调既有 insert/delete/move_nodes，不写新解析器；引用悬空以 warn 点名；插图与 run 级增删不在此列，理由见 3.8 |

**P0a 先于 P0b** 是当时的关键排序：路径解析器是纯函数，可以脱离 transform 独立测透，`_src` 的形状也依赖它来定。事后看这个顺序抓出了 `at`/`path` 分离（§3.1）这个缺口。

P4 落地时验证了当初的判断：`_src` 让每个 DOM 位置都能映射到 def 节点，所以结构编辑增加的只是 insert/delete/move 调用，没有重写任何解析器。

## 5. 开放问题

- ~~表格 `rowSpan`/`colSpan` 的呈现~~ **P1 已解决**：`span[i].cNo` 是 `texts` 的实际下标，被覆盖的格在 `data` 里缺位——这与 HTML `rowspan`/`colspan` 的约定完全一致，直接映射即可，路径天然按实际下标走。
- 公式（`math-latex.js`、`math` 节点）在 HTML 视图中一期整体只读，渲染为 LaTeX 源文本。要做可视化公式预览需引入渲染库，另行评估。
- `textOptions.math`（行内公式）目前不进可编辑白名单，草稿视图里跟随所在 run 一起渲染。
- 写回是**每叶子一次请求**（失焦触发）。批量场景（客户连改十几处后统一提交）会打出多次往返，需要时再加批量接口——服务端逐条校验的语义不变。
- 草稿视图改完后，**版式视图的 PNG 已过期但不会自动重渲**：重渲要过 LibreOffice（约 5–10 秒），不该由每次失焦触发。目前只在状态栏提示，未做「重新渲染」按钮。
- 图片相关能力统一卡在同一个前提上：**没有图片上传通道**。页眉页脚的 `headerImage`/`footerImage`（§3.5.4）和正文插图（§3.8）都要等它落地后再单独设计。
- 并发：同一文档被 agent 和人同时编辑时的冲突策略未定。一期 Playground 是单人本地场景，可暂不处理，但 `_src` 里的 `raw` 天然可以充当乐观锁的基准值（提交时比对 `raw` 是否仍与库中一致）。
