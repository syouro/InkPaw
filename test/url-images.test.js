// url-images.test.js — URL 图片 opt-in 抓取 + 页眉页脚图片
// 抓取用本地 http server，不出网；渲染断言解 docx 查 XML
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const JSZip = require("jszip");
const { createService } = require("../src/service");
const { fetchUrlImagesInDef } = require("../src/fetch-images");
const { validate } = require("../src/validator");

const DEMO_PNG = fs.readFileSync(path.join(__dirname, "..", "examples", "images", "demo.png"));

const makeService = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "docx-mcp-url-"));
  const service = createService({
    dbPath: path.join(dir, "t.db"),
    outputDir: path.join(dir, "output"),
    profilePath: path.join(dir, "style-profile.json"),
  });
  return { service, dir, cleanup: () => { service.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
};

/** 本地图片服务器：/ok.png 正常图；/page.html 错 MIME；/huge 谎报小、实发 6MB；/big 头部就超限 */
const makeImageServer = () => new Promise((resolve) => {
  const server = http.createServer((req, res) => {
    if (req.url === "/ok.png") {
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(DEMO_PNG);
    } else if (req.url === "/page.html") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html>not an image</html>");
    } else if (req.url === "/big") {
      res.writeHead(200, { "Content-Type": "image/png", "Content-Length": String(10 * 1024 * 1024) });
      res.end(); // 客户端看头就该拒，不用真发
    } else if (req.url === "/huge") {
      // 不带 Content-Length（chunked），实发超 5MB——考流式计数
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(Buffer.alloc(6 * 1024 * 1024));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  server.listen(0, "127.0.0.1", () => resolve({
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => server.close(r)),
  }));
});

test("fetchUrlImagesInDef：抓取成功转 base64，MIME/大小超限留 URL + warning", async () => {
  const srv = await makeImageServer();
  try {
    const def = {
      meta: { headerImage: { src: `${srv.base}/ok.png`, height: 24 } },
      contexts: [
        { id: "img-1", type: "image", src: `${srv.base}/ok.png` },
        { id: "img-2", type: "image", src: [`${srv.base}/page.html`, `${srv.base}/big`, `${srv.base}/huge`] },
        { id: "tbl-1", type: "table", data: [{ texts: ["a"] }],
          tableOptions: { images: { 0: [{ type: "image", cNo: [0], src: `${srv.base}/ok.png`, width: 50, height: 50 }] } } },
      ],
    };
    const { def: out, changed, warnings } = await fetchUrlImagesInDef(def);
    assert.strictEqual(changed, true);
    // 成功的三处（同一 URL 只抓一次）都成了 data:image/png
    assert.match(out.contexts[0].src, /^data:image\/png;base64,/);
    assert.match(out.meta.headerImage.src, /^data:image\/png;base64,/);
    assert.match(out.contexts[2].tableOptions.images[0][0].src, /^data:image\/png;base64,/);
    // 抓下来的字节和原图一致
    const b64 = out.contexts[0].src.split(",")[1];
    assert.ok(Buffer.from(b64, "base64").equals(DEMO_PNG));
    // 失败的三处保留原 URL，各报一条 warning
    assert.deepStrictEqual(out.contexts[1].src, def.contexts[1].src);
    assert.strictEqual(warnings.length, 3);
    assert.ok(warnings.some((w) => w.includes("MIME")));
    assert.ok(warnings.filter((w) => w.includes("5MB")).length === 2);
    // 传入 def 不被改动
    assert.match(def.contexts[0].src, /^http:/);
  } finally {
    await srv.close();
  }
});

test("校验器：URL 图未开 fetchUrlImages → warn 指引；开了不报", () => {
  const def = { contexts: [{ id: "i1", type: "image", src: "https://example.com/a.png" }] };
  const off = validate(def, {});
  assert.ok(off.some((i) => i.rule === "image-url-not-enabled" && i.level === "warn"));
  const on = validate(def, { fetchUrlImages: true });
  assert.ok(!on.some((i) => i.rule === "image-url-not-enabled"));
});

test("校验器：meta.headerImage/footerImage 形态与存在性", () => {
  const imagesBaseDir = path.join(__dirname, "..", "examples", "images");
  const bad = validate({ meta: { headerImage: "logo.png" }, contexts: [] }, {});
  assert.ok(bad.some((i) => i.rule === "meta-image-invalid"));
  const missing = validate({ meta: { footerImage: { src: "no-such.png" } }, contexts: [] }, { imagesBaseDir });
  assert.ok(missing.some((i) => i.rule === "image-missing" && i.message.includes("footerImage")));
  const ok = validate({ meta: { headerImage: { src: "demo.png", height: 24 } }, contexts: [] }, { imagesBaseDir });
  assert.deepStrictEqual(ok, []);
  const url = validate({ meta: { headerImage: { src: "https://example.com/logo.png" } }, contexts: [] }, {});
  assert.ok(url.some((i) => i.rule === "image-url-not-enabled"));
});

test("端到端：opt-in 渲染抓取回写 def，二次渲染离线可用", async () => {
  const srv = await makeImageServer();
  const { service, cleanup } = makeService();
  try {
    const { docId, issues } = service.createDocument({
      title: "url-e2e",
      def: {
        meta: { fetchUrlImages: true, headerText: "URL 测试" },
        contexts: [
          { type: "heading", level: 1, text: "概述" },
          { id: "img-url", type: "image", src: `${srv.base}/ok.png` },
          { id: "img-bad", type: "image", src: `${srv.base}/page.html` },
        ],
      },
    });
    // opt-in 开着：URL 不报 image-url-not-enabled
    assert.ok(!issues.some((i) => i.rule === "image-url-not-enabled"));

    const r1 = await service.renderDocument({ docId });
    assert.strictEqual(r1.ok, true);
    assert.ok(r1.warnings.some((w) => w.includes("MIME")), "错 MIME 的 URL 应报抓取失败 warning");
    // 回写：成功的成 base64，失败的留 URL
    const [okNode, badNode] = service.getNodes({ docId, ids: ["img-url", "img-bad"] });
    assert.match(okNode.src, /^data:image\/png;base64,/);
    assert.match(badNode.src, /^http:/);
    // docx 包里真有这张图
    const zip = await JSZip.loadAsync(fs.readFileSync(r1.path));
    assert.ok(Object.keys(zip.files).some((f) => f.startsWith("word/media/")));

    // 服务器关掉后二次渲染：base64 已自包含，不再拉网络
    await srv.close();
    const r2 = await service.renderDocument({ docId });
    assert.strictEqual(r2.ok, true);
    assert.ok(!r2.warnings.some((w) => w.includes(`${srv.base}/ok.png`)));
  } finally {
    await srv.close().catch(() => {});
    cleanup();
  }
});

test("页眉 logo + 文字、页脚图 + 页码：右制表位同段共存", async () => {
  const { service, cleanup } = makeService();
  try {
    const imagesDir = path.join(__dirname, "..", "examples", "images");
    const { docId, issues } = service.createDocument({
      title: "logo",
      def: {
        meta: {
          imagesDir,
          headerText: "月度报告",
          headerImage: { src: "demo.png", height: 24 },
          footerImage: { src: "demo.png", height: 16 },
        },
        contexts: [{ type: "heading", level: 1, text: "概述" }],
      },
    });
    assert.deepStrictEqual(issues, []);
    const r = await service.renderDocument({ docId });
    assert.strictEqual(r.ok, true);
    const zip = await JSZip.loadAsync(fs.readFileSync(r.path));
    const headers = await Promise.all(zip.file(/word\/header\d*\.xml/).map((f) => f.async("string")));
    const footers = await Promise.all(zip.file(/word\/footer\d*\.xml/).map((f) => f.async("string")));
    const header = headers.find((x) => x.includes("a:blip") || x.includes("w:drawing"));
    assert.ok(header, "默认页眉里应有图片");
    assert.ok(header.includes("<w:tab/>") && header.includes("月度报告"), "logo 与文字经制表位同段共存");
    const footer = footers.find((x) => x.includes("a:blip") || x.includes("w:drawing"));
    assert.ok(footer, "默认页脚里应有图片");
    assert.ok(footer.includes("PAGE"), "页码仍在");
  } finally {
    cleanup();
  }
});

test("markdown：URL 图开 fetchUrlImages 不再报 md-image-url", () => {
  const { service, cleanup } = makeService();
  try {
    const md = "# 标题\n\n![远程图](https://example.com/a.png)\n";
    const off = service.createDocumentFromMarkdown({ title: "md-off", markdown: md });
    assert.ok(off.issues.some((i) => i.rule === "md-image-url"));
    const on = service.createDocumentFromMarkdown({ title: "md-on", markdown: md, meta: { fetchUrlImages: true } });
    assert.ok(!on.issues.some((i) => i.rule === "md-image-url"));
    assert.ok(!on.issues.some((i) => i.rule === "image-url-not-enabled"));
  } finally {
    cleanup();
  }
});
