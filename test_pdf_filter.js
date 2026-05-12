const { load } = require("cheerio")

const html = `<p>Test text</p><figure><img src="data:image/jpeg;base64,aBcD"/></figure>`;
const document = load(html);
let root = document(".epub-page-body").first();
if (root.length === 0) {
   root = document("body").first();
}

console.log("Root length:", root.length)
root.children().each((_, child) => {
   console.log("Child tag:", child.tagName)
})
