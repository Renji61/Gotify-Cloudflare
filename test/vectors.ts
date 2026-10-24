// Test vectors produced by real Go code: golang.org/x/crypto/bcrypt and crypto/ed25519,
// with Gotify's own token functions (auth/token.go) for the token forms.
// They come from a small Go program that imports those packages (a throwaway helper,
// not part of this repository); the values below are copied from its output verbatim.

export interface BcryptVector {
  password: string;
  cost: number;
  hash: string;
}

export interface TokenVector {
  ident: string;
  seedHex: string;
  pubHex: string;
  /** gtfy<ident>.<base64url seed> */
  private: string;
  /** gtfy<ident>.<base64url public key>: what the database stores */
  public: string;
  timestamp: number;
  /** Ed25519ph signature over SHA-512("iat=<timestamp>") */
  sigHex: string;
  signed: string;
}

/** Hashes made by Go's bcrypt.GenerateFromPassword. */
export const BCRYPT_VECTORS: BcryptVector[] = [
  {
    "password": "admin",
    "cost": 10,
    "hash": "$2a$10$x/hqtpbi.5H9PSLYr18FI.qKgLDBjE2m2mqvqbto/b1eB8IiJr5ui"
  },
  {
    "password": "pw",
    "cost": 5,
    "hash": "$2a$05$ZXxjG/8ykchWtgft6iXEoO0ZWVmzESr68gGUitIsbCtrS9sJyI4Yy"
  },
  {
    "password": "secret",
    "cost": 4,
    "hash": "$2a$04$mZoaOzA2gO2cs9CKRW4xPecXG1SQ0ZHy3rYAxJKGkZ1kJS.XuB4We"
  },
  {
    "password": "secret",
    "cost": 10,
    "hash": "$2a$10$RW.Az7mBOLZPlaeWZxEMOeQw8dJAkFQQH9ObK50thUja40gurzfJ2"
  },
  {
    "password": "",
    "cost": 5,
    "hash": "$2a$05$wQa0a.PLqRM/vHkBeJ.IjO5WFhpRwo/tznRyC8pJ93cnbKeA2nOnm"
  },
  {
    "password": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "cost": 6,
    "hash": "$2a$06$FzBavJeaFGn8JXFLw9HV4OtZD8K4PKtk/jD/pinDVamAC.jUyTzl2"
  },
  {
    "password": "abababababababababababababababababababababababababababababababababababab",
    "cost": 5,
    "hash": "$2a$05$F/w.ihgPledPatsdknHK3.jPe.8I4AE0slzTh3h.bNu.Otiguo3Dy"
  },
  {
    "password": "pässwörd✓",
    "cost": 5,
    "hash": "$2a$05$ck59vHKeawg8rgxphtn7qeC1APc/McZWoRLhsZp4KVOSetHB997JW"
  },
  {
    "password": "pässwörd✓",
    "cost": 10,
    "hash": "$2a$10$4CCg68LkLmlauHnkFiaYHumZacaibeb7eQt2T9RlVsWWwxeVZH9qa"
  },
  {
    "password": "éééééééééééééééééééééééééééééééééééé",
    "cost": 5,
    "hash": "$2a$05$Jy6nBUbJlK0qvpccm7K/DuIi447zXy9oZJCI8g2nqKaOHH0m4meBq"
  },
  {
    "password": "correct horse battery staple",
    "cost": 8,
    "hash": "$2a$08$oIAyJuF0m0Z9B8zoj1c5Iu2vDrQlu1ZcOgcNycpcfMSinP0q.U00."
  }
];

/** Error text Go returns for a 73 byte password. */
export const BCRYPT_TOO_LONG_ERROR = "bcrypt: password length exceeds 72 bytes";

/** Classic crypt_blowfish vectors (the ones in x/crypto's tests): password, hash. */
export const CLASSIC_BCRYPT: Array<[string, string]> = [
  ["U*U", "$2a$05$CCCCCCCCCCCCCCCCCCCCC.E5YPO9kmyuRGyh0XouQYb4YMJKvyOeW"],
  ["U*U*", "$2a$05$CCCCCCCCCCCCCCCCCCCCC.VGOzA784oUp/Z0DY336zx7pLYAy0lwK"],
  ["U*U*U", "$2a$05$XXXXXXXXXXXXXXXXXXXXXOAcXxm9kjPGEMsLznoKqmqw7tc8WCx4a"],
];

export const TOKEN_VECTORS: TokenVector[] = [
  {
    "ident": "a",
    "seedHex": "92b3a8df0093dfd1d928d32dfdf959c87bbe312c5c99128ce9a737d073771aaa",
    "pubHex": "0b2291c42364d4097e3eed33b16fed099cd239d1ebbd708fc90173204f6e4b77",
    "private": "gtfya.krOo3wCT39HZKNMt_flZyHu-MSxcmRKM6ac30HN3Gqo",
    "public": "gtfya.CyKRxCNk1Al-Pu0zsW_tCZzSOdHrvXCPyQFzIE9uS3c",
    "timestamp": 12345,
    "sigHex": "19239f13d8c06b68a1984a66eec44924700fa3c5fa6107bc7fa7898f02a442d644df205166c114a89b15e2abe33741b348b036d8ca7bcd2df0e9583a87cdb10e",
    "signed": "gtfya.CyKRxCNk1Al-Pu0zsW_tCZzSOdHrvXCPyQFzIE9uS3c.12345.GSOfE9jAa2ihmEpm7sRJJHAPo8X6YQe8f6eJjwKkQtZE3yBRZsEUqJsV4qvjN0GzSLA22Mp7zS3w6Vg6h82xDg"
  },
  {
    "ident": "c",
    "seedHex": "19b864608cdc2664c2a4875c45f047b4f3bca45efc208648169821f5345d2862",
    "pubHex": "286498f1cf1c880939912c49305aba3d3e7d7a8ffb8ea781dfef152a83081d00",
    "private": "gtfyc.GbhkYIzcJmTCpIdcRfBHtPO8pF78IIZIFpgh9TRdKGI",
    "public": "gtfyc.KGSY8c8ciAk5kSxJMFq6PT59eo_7jqeB3-8VKoMIHQA",
    "timestamp": 1735732800,
    "sigHex": "905ddda2cd44590da63b624e34ea056ac98a25bdcfcf0ce8eae96acc7e82d93b202453aae9eb33d37255c490ce02e3d9a22ca4c8d43928bcdb830bce392beb05",
    "signed": "gtfyc.KGSY8c8ciAk5kSxJMFq6PT59eo_7jqeB3-8VKoMIHQA.1735732800.kF3dos1EWQ2mO2JONOoFasmKJb3Pzwzo6ulqzH6C2TsgJFOq6esz03JVxJDOAuPZoiykyNQ5KLzbgwvOOSvrBQ"
  },
  {
    "ident": "x_y",
    "seedHex": "d6028a8a1034fd18be246a6a73831a21200761f4ef81a3d771e58748e283c04d",
    "pubHex": "e7a69cd5271c6fb25d2dd1ee24824e4c3a4fb4deeb0e9e20401b04477568a8ab",
    "private": "gtfyx_y.1gKKihA0_Ri-JGpqc4MaISAHYfTvgaPXceWHSOKDwE0",
    "public": "gtfyx_y.56ac1Sccb7JdLdHuJIJOTDpPtN7rDp4gQBsER3VoqKs",
    "timestamp": 1893456000,
    "sigHex": "a9f25f5a5465f7a18cfd8f3b61fbfbb9d33a0bf7e9b7acefb63ad4e9f1fa4ce376e9fc07bb094ad1a4c261bf170e72b7edb17c8be2a2b1fac3455950c317e302",
    "signed": "gtfyx_y.56ac1Sccb7JdLdHuJIJOTDpPtN7rDp4gQBsER3VoqKs.1893456000.qfJfWlRl96GM_Y87Yfv7udM6C_fpt6zvtjrU6fH6TON26fwHuwlK0aTCYb8XDnK37bF8i-KisfrDRVlQwxfjAg"
  }
];

/** RFC 8032 section 7.3, Ed25519ph with an empty context (seed, public key, signature of SHA-512("abc")). */
export const RFC8032 = {
  "pubHex": "ec172b93ad5e563bf4932c70e1245034c35467ef2efd4d64ebf819683467e2bf",
  "seedHex": "833fe62409237b9d62ec77587520911e9a759cec1d19755b7da901b96dca3d42",
  "sigHex": "98a70222f0b8121aa9d30f813d683f809e462b469c7ff87639499bb94e6dae4131f85042463c2a355a2003d062adf5aaa10b8c61e636062aaad11c2a26083406"
};
