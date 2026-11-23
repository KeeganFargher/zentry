// A real .NET event and the source bundle for the build that sent it, made
// with the stock tools rather than written by hand, so the tests read what
// production will. To regenerate:
//
// 1. A console app in /src/Demo on Sentry 6.4.1 (Program.cs calls
//    Demo.Scoring.Fingerprint.Build("Tea 99999999999 pcs"), whose int.Parse
//    overflows, and sends the exception with SentrySdk.CaptureException).
// 2. `dotnet publish -c Release -o /src/publish -p:DebugType=portable`, run
//    it against a DSN that records envelopes, and keep the event's platform,
//    level, release, exception, debug_meta and sdk.
// 3. `sentry-cli debug-files bundle-sources /src/publish/Demo.pdb` (2.58.6)
//    for the bundle, base64 below.

import type { JsonObject } from "@/shared/contract";

/** Debug id of Demo.dll, in the event's debug_meta and in the bundle's manifest. */
export const DEMO_DEBUG_ID = "f8f62cc3-cb15-42c7-bc14-5ef93b12ff18-e40df841";

/** /src/Demo/Scoring/Fingerprint.cs as the bundle holds it. */
export const FINGERPRINT_SOURCE =
  'using System.Globalization;\nusing System.Text.RegularExpressions;\n\nnamespace Demo.Scoring;\n\npublic static class Fingerprint\n{\n    private static readonly Regex CountRegex = new(@"(\\d+)\\s*pcs", RegexOptions.Compiled);\n\n    public static string Build(string title)\n    {\n        return CountRegex.Replace(title, match =>\n        {\n            var count = int.Parse(match.Groups[1].Value, CultureInfo.InvariantCulture);\n            return count.ToString(CultureInfo.InvariantCulture);\n        });\n    }\n}\n';

export const DOTNET_EVENT: JsonObject = {
  platform: "csharp",
  level: "error",
  release: "1.0.0",
  exception: {
    values: [
      {
        type: "System.OverflowException",
        value: "Value was either too large or too small for an Int32.",
        module:
          "System.Private.CoreLib, Version=9.0.0.0, Culture=neutral, PublicKeyToken=7cec85d7bea7798e",
        thread_id: 1,
        stacktrace: {
          frames: [
            {
              filename: "Program.cs",
              function: "void Program.<Main>$(?)",
              lineno: 7,
              colno: 9,
              abs_path: "/src/Demo/Program.cs",
              in_app: true,
              package: "Demo, Version=1.0.0.0, Culture=neutral, PublicKeyToken=null",
              instruction_addr: "0x25",
              addr_mode: "rel:1",
              function_id: "0x2",
            },
            {
              filename: "Scoring/Fingerprint.cs",
              function: "string Fingerprint.Build(string title)",
              lineno: 12,
              colno: 9,
              abs_path: "/src/Demo/Scoring/Fingerprint.cs",
              in_app: true,
              package: "Demo, Version=1.0.0.0, Culture=neutral, PublicKeyToken=null",
              instruction_addr: "0x1f",
              addr_mode: "rel:1",
              function_id: "0x5",
            },
            {
              function:
                "string Regex.Replace(MatchEvaluator evaluator, Regex regex, string input, int count, int startat)",
              in_app: false,
              package:
                "System.Text.RegularExpressions, Version=9.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a",
              instruction_addr: "0x43",
              addr_mode: "rel:2",
              function_id: "0x18f",
            },
            {
              function:
                "void Regex.RunAllMatchesWithCallback<TState>(string inputString, ReadOnlySpan<char> inputSpan, int startat, ref TState state, MatchCallback<TState> callback, RegexRunnerMode mode, bool reuseMatchObject) x 2",
              in_app: false,
              package:
                "System.Text.RegularExpressions, Version=9.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a",
              instruction_addr: "0x65",
              addr_mode: "rel:2",
              function_id: "0x15e",
            },
            {
              function:
                "string Regex.Replace(MatchEvaluator evaluator, Regex regex, string input, int count, int startat)+(ref ValueTuple<StructListBuilder<ReadOnlyMemory<char>>, MatchEvaluator, int, string, int> state, Match match) => { }",
              in_app: false,
              package:
                "System.Text.RegularExpressions, Version=9.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a",
              instruction_addr: "0x3c",
              addr_mode: "rel:2",
              function_id: "0x1b2",
            },
            {
              filename: "Scoring/Fingerprint.cs",
              function: "string Fingerprint.Build(string title)+(Match match) => { }",
              lineno: 14,
              colno: 13,
              abs_path: "/src/Demo/Scoring/Fingerprint.cs",
              in_app: true,
              package: "Demo, Version=1.0.0.0, Culture=neutral, PublicKeyToken=null",
              instruction_addr: "0x0",
              addr_mode: "rel:1",
              function_id: "0xc",
            },
            {
              function: "int int.Parse(string s, IFormatProvider provider)",
              in_app: false,
              package:
                "System.Private.CoreLib, Version=9.0.0.0, Culture=neutral, PublicKeyToken=7cec85d7bea7798e",
              instruction_addr: "0x0",
              addr_mode: "rel:0",
              function_id: "0x14b9",
            },
            {
              function: "void Number.ThrowOverflowException<TInteger>()",
              in_app: false,
              package:
                "System.Private.CoreLib, Version=9.0.0.0, Culture=neutral, PublicKeyToken=7cec85d7bea7798e",
              instruction_addr: "0x10",
              addr_mode: "rel:0",
              function_id: "0x1958",
            },
          ],
        },
        mechanism: {
          type: "generic",
          handled: true,
          data: {
            HResult: "0x80131516",
          },
        },
      },
    ],
  },
  debug_meta: {
    images: [
      {
        type: "pe_dotnet",
        debug_id: "c6d5759a-1f4e-614d-25c9-6a2e469a934a-fbf21aad",
        debug_checksum: "SHA256:9a75d5c64e1f4d6125c96a2e469a934aad1af2fb044fa9b35767bf24a9c343b9",
        debug_file:
          "/_/artifacts/obj/coreclr/System.Private.CoreLib/linux.x64.Release/System.Private.CoreLib.pdb",
        code_id: "811F2266e76800",
        code_file:
          "/usr/share/dotnet/shared/Microsoft.NETCore.App/9.0.23/System.Private.CoreLib.dll",
      },
      {
        type: "pe_dotnet",
        debug_id: "f8f62cc3-cb15-42c7-bc14-5ef93b12ff18-e40df841",
        debug_checksum: "SHA256:c32cf6f815cbc7223c145ef93b12ff1841f80de4ce4174effc50e726dcadcf1f",
        debug_file: "/src/Demo/obj/Release/net9.0/Demo.pdb",
        code_id: "C42C68478000",
        code_file: "/src/publish/Demo.dll",
      },
      {
        type: "pe_dotnet",
        debug_id: "b7a04c76-dfd0-6287-04a7-ef0d88d84b3c-a166b6c0",
        debug_checksum: "SHA256:764ca0b7d0df876204a7ef0d88d84b3cc0b666a186800f21fa7a8651c4a86d07",
        debug_file:
          "/_/artifacts/obj/System.Text.RegularExpressions/Release/net9.0/System.Text.RegularExpressions.pdb",
        code_id: "E0AE51F2146a00",
        code_file:
          "/usr/share/dotnet/shared/Microsoft.NETCore.App/9.0.23/System.Text.RegularExpressions.dll",
      },
    ],
  },
  sdk: {
    packages: [
      {
        name: "nuget:sentry.dotnet",
        version: "6.4.1",
      },
    ],
    name: "sentry.dotnet",
    version: "6.4.1",
  },
};

const BUNDLE_BASE64 = [
  "U1lTQgIAAABQSwMEFAAAAAgAAAAhAGSHH0q6AAAAIQEAABkAAABmaWxlcy9zcmMvRGVtby9Qcm9ncmFtLmNzXU/BDoIwDL3v",
  "KxpO4zLEiwLBGEUTr+IP4GhkEbcFtkRD+HcHBEl8Tdq+tq9NbSvkA3KUpvkkhNiR0onn5ZNdpDBUQbqDDhTLWgkpeJUxOg4C",
  "be+14PtwvWErZ2G83URREHqJm7xijUWLw3Q4dF2x933SEXBwu8c4sQEZvhTLuWrceXZ2DhvtcsMOVtQl9W5YQLQANG89Pxnl",
  "/eh5YXgF9PTmqI1QEnDO/L9Ty2/HQhvb4E9DF828uidfUEsDBBQAAAAIAAAAIQDGNOx5GgEAAPYBAAAlAAAAZmlsZXMvc3Jj",
  "L0RlbW8vU2NvcmluZy9GaW5nZXJwcmludC5jc41PzU4CMRC+9ykaTouSJp4JxohKOGmEeBEPQ3fEJt226UwRNLy7s8uqeHNO",
  "0873W8iFjV7sibExMx/X4N0HsIthrMrpbYk7No+4KR7y7S5lJBIQjZUK0CAlsKhvsIlmYWMWnhxSWXtnNbHoWW09EOk7OWFO",
  "gmD1qbSM7Ftg/IZlhDoGv9fihTs9jSXwcZ3ogO/V1aBa1efDFZ0lS4PREXaf2sRkprFJzmM9FPdO+08C4jaYvi7O11X/YMce",
  "hx34GKedjFxyOPGW4slLw6qDj3QDbN/05PKH8cttZwtZ25YsmaWoeYBMWHUkM8uxJHq+eDFP4ItoTYsXN5yH12jmQagOAvef",
  "0uNUt8/VSZtlXHQVqn8KHPr9oA7qC1BLAwQUAAAACAAAACEAPopXg3YAAAA8AQAAOAAAAGZpbGVzL3NyYy9EZW1vL29iai9S",
  "ZWxlYXNlL25ldDkuMC9EZW1vLkdsb2JhbFVzaW5ncy5nLmNzjc0xDoMwDIXhnVPkAk12qLp0aCtV7VAu4IKVRg0OxGbg9oCY",
  "sRit77eec+YMo6STR8IMgq27FD6mL0QzciBvtqMsP0iSp2oHJxbsVLTXFCM2EhKxva1rodEfHm/dn4EGvXih2LtIr1f1LyO0",
  "CxzMbA3856qYAVBLAwQUAAAACAAAACEA9pfYZZgAAADFAAAAUAAAAGZpbGVzL3NyYy9EZW1vL29iai9SZWxlYXNlL25ldDku",
  "MC8uTkVUQ29yZUFwcCxWZXJzaW9uPXY5LjAuQXNzZW1ibHlBdHRyaWJ1dGVzLmNzVYy9CsIwFEb3gu9w6aRQUlerFYo/Ywct",
  "LuKQ6jUE81OSGyVvbxQVHA/fOV9ZwoIHsgINOk54gXI5yoKXRsA+ekI9/0e2w6vCM0lr0nLk3qPuVaxAKNtzVVVfLRiSGtkB",
  "nU9uOmAddwJp67jGh3W3hsjJPhCOc9ZuupV12AxD8Qnq+4xN8wJ++lr6QfHYJoQa3gm8lMkpewJQSwMEFAAAAAgAAAAhALW6",
  "NuD1AAAAHQIAADYAAABmaWxlcy9zcmMvRGVtby9vYmovUmVsZWFzZS9uZXQ5LjAvU2VudHJ5LkF0dHJpYnV0ZXMuY3OtUMFK",
  "AzEQvecrhj0p2ORuRdAWPRXEFTyIh9ns7G4km8Bk1pK/N1FblF47t7z38ubNM2Z11lHGwA0uElcjBWIU6m8rVudlcgls7An2",
  "mODIQ5cBQWL0uigP4s2EYaRUcJD6b3CeYMYMFpdE4IKNzGQFOprw00UGDD3snfcFAR+TgBsOZjLRz+JixHTcrL/TmtO4q7OO",
  "UktyYYQ2J6F5/e+ln2nw5QwXw1qpN0yJ5s7n61Na3/1yOxLsUfCiaSkIZ/3E8aNotq72ETk3V9CYxNZsaY6muXxX9c7Hv33X",
  "Qnbt/eJ8D6/shDalnQfGcS6WYH3JoZX6AlBLAwQUAAAACAAAACEAmV40xScBAACdAwAANgAAAGZpbGVzL3NyYy9EZW1vL29i",
  "ai9SZWxlYXNlL25ldDkuMC9EZW1vLkFzc2VtYmx5SW5mby5jc62STUvDQBCG7/srhp700ESvVoRaqXgQpC16EA+TZJIM7Ifs",
  "zlry791UW1qKEkpnTzuz88zHvnk+PqupPIdbjOLGDVnyKFTd9b7eVi0HKF1FsMYAuzgUHSCIczpLL7ePZy3ahkLyg/R5NWsC",
  "gx2UGAMB29J5T6VAQS1+sfOAtoI1a508oF0Q4HoLk5Z+CieQp13lbNNtftzu+KymVAxsG1h2QchMDm7ZgmqdxmBnJ0q9Ywhk",
  "Ct3dHIez6W9s5swn2m4q4rmIQhejBzJudPkxNN3W3MQ0a/LuQRakCQMN5szTh7ySD4eU6+yqP4MpT7Z23mx6Qf0HbjDsxbsq",
  "lnLqZlYsmk5N/ncVvc4e9/XeC/J5eR9ZV/DmWWiW1Dn32BiyAqVOFTOlvgFQSwMEFAAAAAgAAAAhAPx0qy0OAQAAcAMAAA0A",
  "AABtYW5pZmVzdC5qc29urZFPT8QgEMW/C+ctbLtd7W7iofFfvBjjqtcN0KFWWyAD1TSbfnfpmnhwa9KkXsgww3vvBxyIqmpw",
  "ZHv4LphDya6gMewBTYm8ofI49J0FsiXOtCiBLIjl/jXsR4/3i99eO2mw0iW7CQugDbWf6vuH9DTDiDf2CDVwB0yD39Alo/fX",
  "T5cGIbd28QLoKqMvPsKA5s5BI+ou9x4r0XpwU3Hmp0wiH/o/+jutzAy+Ua/pFLe1Ebx+duH9HS3ncpy6TSLZgfbY0X/5r1Gv",
  "PmBwlIO41e/afOrgVoBoy31VhKbK1Fki5SqSIl5HaSLPIyHjNFqD2qxEnCgVZxGky0JlaRykIRek32veDHzHq9tCkP4LUEsB",
  "AhQDFAAAAAgAAAAhAGSHH0q6AAAAIQEAABkAAAAAAAAAAAAAAKSBCAAAAGZpbGVzL3NyYy9EZW1vL1Byb2dyYW0uY3NQSwEC",
  "FAMUAAAACAAAACEAxjTseRoBAAD2AQAAJQAAAAAAAAAAAAAApIH5AAAAZmlsZXMvc3JjL0RlbW8vU2NvcmluZy9GaW5nZXJw",
  "cmludC5jc1BLAQIUAxQAAAAIAAAAIQA+ileDdgAAADwBAAA4AAAAAAAAAAAAAACkgVYCAABmaWxlcy9zcmMvRGVtby9vYmov",
  "UmVsZWFzZS9uZXQ5LjAvRGVtby5HbG9iYWxVc2luZ3MuZy5jc1BLAQIUAxQAAAAIAAAAIQD2l9hlmAAAAMUAAABQAAAAAAAA",
  "AAAAAACkgSIDAABmaWxlcy9zcmMvRGVtby9vYmovUmVsZWFzZS9uZXQ5LjAvLk5FVENvcmVBcHAsVmVyc2lvbj12OS4wLkFz",
  "c2VtYmx5QXR0cmlidXRlcy5jc1BLAQIUAxQAAAAIAAAAIQC1ujbg9QAAAB0CAAA2AAAAAAAAAAAAAACkgSgEAABmaWxlcy9z",
  "cmMvRGVtby9vYmovUmVsZWFzZS9uZXQ5LjAvU2VudHJ5LkF0dHJpYnV0ZXMuY3NQSwECFAMUAAAACAAAACEAmV40xScBAACd",
  "AwAANgAAAAAAAAAAAAAApIFxBQAAZmlsZXMvc3JjL0RlbW8vb2JqL1JlbGVhc2UvbmV0OS4wL0RlbW8uQXNzZW1ibHlJbmZv",
  "LmNzUEsBAhQDFAAAAAgAAAAhAPx0qy0OAQAAcAMAAA0AAAAAAAAAAAAAAKSB7AYAAG1hbmlmZXN0Lmpzb25QSwUGAAAAAAcA",
  "BwCBAgAAJQgAAAAA",
].join("");

export function demoBundle(): Uint8Array {
  return Uint8Array.from(atob(BUNDLE_BASE64), (char) => char.charCodeAt(0));
}
