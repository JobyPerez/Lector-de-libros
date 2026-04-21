const tests = [
  "12",
  "- 12 -",
  "Página 12",
  "12 / 40",
  "Some actual text 12"
];

const regex = /^(?:-?\s*\d+\s*-?|P[aá]gina\s*\d+|P[aá]g\.\s*\d+|\d+\s*\/\s*\d+)$/i;

tests.forEach(t => {
  console.log(t, regex.test(t));
});
