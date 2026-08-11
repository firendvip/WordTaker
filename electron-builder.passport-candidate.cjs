const { build } = require("./package.json");

module.exports = {
  ...build,
  win: {
    ...(build.win || {}),
    target: [
      {
        target: "nsis",
        arch: ["x64", "arm64"],
      },
    ],
  },
  nsis: {
    ...(build.nsis || {}),
    include: "build/installer-passport-candidate.nsh",
  },
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
