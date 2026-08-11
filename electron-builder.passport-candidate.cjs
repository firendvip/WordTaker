const { build } = require("./package.json");

module.exports = {
  ...build,
  extraMetadata: {
    ...(build.extraMetadata || {}),
    wordtakerPassportCandidate: true,
  },
  protocols: [
    {
      name: "Wangsan WordTaker OAuth",
      schemes: ["wangsan-wordtaker"],
    },
  ],
};
