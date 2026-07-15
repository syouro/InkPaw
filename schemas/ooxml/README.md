# OOXML Transitional Schemas

来源：ECMA-376 Transitional（经 python-openxml/python-docx 仓库 `ref/xsd/` 镜像下载，2026-07-07），
`xml.xsd` 来自 w3.org，两处 `xsd:import` 手工补了 `schemaLocation="xml.xsd"`（原文件省略，xmllint 编译不过）。

`strip-mce.xslt`：schema 校验前的 MCE 预处理——剥掉 `mc:Ignorable` 属性、可忽略命名空间
（w14/w15/wp14 等）的元素与属性，并把 `mc:AlternateContent` 展开为首个 Choice。
真实消费方（Word/LibreOffice）解析前都做这一步，不剥直接校验会误报。

供 `scripts/docx-validate.js` 使用，勿手工改动 xsd 内容。
