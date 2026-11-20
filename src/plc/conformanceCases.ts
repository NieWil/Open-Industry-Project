// The ST conformance corpus: the single source of truth for "what the standard says
// this program does", read by two independent checkers:
//
//   - src/plc/conformance.test.ts runs every case through the interpreter and the
//     emitted TypeScript, asserting the goldens below and inter-backend agreement.
//   - scripts/oracle-matiec.mjs replays every case, rendered as a spec-legal IEC
//     program, through MATIEC (`iec2c`), an external compiler.
//
// Every expected value here is hand-derived from IEC 61131-3, or, where IEC leaves a choice open, from
// the engine's own documented rule (docs/st-conformance.md). It is never taken from running our own engine or a
// vendor's tool, so the corpus follows the standard rather than snapshotting the implementation.
// Deliberate departures carry a `divergence` note. Cases an external compiler cannot be fed verbatim
// carry `oracle: { skip }` saying why. Every case is either checked externally or states why it can't be.

import type { TagValue } from './types'

/** One scan step: write inputs, scan dt seconds, then assert the expected image. */
export interface Step {
  in?: Record<string, TagValue>
  dt?: number
  /** exact expectations (integers / booleans / exactly-representable reals) */
  expect?: Record<string, TagValue>
  /** float expectations checked with toBeCloseTo (accumulated timer clocks etc.) */
  close?: Record<string, number>
  /** the scan must fault in both backends; ends the case */
  throws?: RegExp
}

export interface Case {
  name: string
  src: string
  /** Scans to run. Empty for a `rejects` case, which never gets as far as running. */
  steps: Step[]
  /**
   * The program must be rejected at compile time, with a message matching this. These are
   * the strictness half of portability: a program a real compiler will not build must not
   * build here either, or the simulator silently accepts code the target rejects. The
   * external oracle inverts its verdict for these: MATIEC *accepting* one is the failure.
   */
  rejects?: RegExp
  /**
   * A deliberate departure from the letter of the standard, with the reason. These are the
   * ledger of "we know, and here is why" - the external oracle reports them as known
   * divergences rather than failures.
   */
  divergence?: string
  /**
   * How the external oracle should treat this case.
   *
   * - `skip`: it cannot be replayed verbatim. A skip is a finding in its own right (usually:
   *   the case exercises something our subset spells differently from the standard), so the
   *   note has to say what, not just that.
   * - `editionReject`: MATIEC is an IEC **2nd edition** compiler and will refuse this
   *   program, while 3rd edition accepts it. The
   *   rejection is the expected answer and is not a defect in this engine. Without this
   *   distinction tier 1 cannot ever be green, because it would be reporting the age of the
   *   oracle as a bug in the subject.
   */
  oracle?: { skip?: string; editionReject?: string }
}

export interface CaseGroup {
  title: string
  cases: Case[]
}

/** Why a case about code outside every POU beside a CONFIGURATION has nothing to compare when it is refused. */
const OUTSIDE_EVERY_POU =
  "code outside every POU beside a CONFIGURATION, and the PROGRAM line with no type that runs it, are this engine's extension, so an IEC compiler reads neither. An accepted program is exported as a PROGRAM of its own and compared that way; a refused one has no IEC form to hand a compiler"

/**
 * Why the array-of-instances cases cannot reach an external compiler, as measured. Kept
 * in one place because several cases share it word for word, and copies would drift apart.
 */
const FB_ARRAY_UNCHECKABLE =
  'no external compiler here can build it. MATIEC (2nd edition) has no arrays of function-block instances and refuses the declaration ("invalid item data type in array specification"), and STruC++ 0.6.2 cannot parse a call on an array element ("Expected `Assign`, found `(`"), so it never reaches the check. The goldens are checked in-process, through both backends'

/** The same limit, for a `rejects` case: both compilers answer, but not about the rule the case is for. */
const FB_ARRAY_REJECT_UNCHECKABLE =
  'MATIEC refuses this program before reaching the rule it is about, because it has no arrays of function-block instances at all, so its rejection says nothing about the rule; STruC++ is not the strictness oracle (see scripts/oracle-strucpp.mjs). The rule is checked in-process, through both backends'

/** Why a starting value that mixes the two kinds of list cannot reach an external compiler, as
 *  measured; shared by every case that nests one kind of list inside the other. */
const STRUCTURED_LIST_UNCHECKABLE =
  'no external compiler here can check it. MATIEC takes a (field := ...) list, nested ones included, but refuses the two kinds of list mixed: a [...] list inside a struct\'s initializer, or field lists inside an array\'s [...] list, whether the array type is named or spelled out ("Initialization element identifier (...) is not declared in referenced structure/FB scope, or is set to value of incompatible datatype"). STruC++ 0.6.2 has no structured initial values at all. The goldens are checked in-process, through both backends'

/** Why an object-oriented case is an edition difference: measured against STruC++ 0.6.2. */
const OOP_EDITION =
  'MATIEC is a 2nd-edition compiler, and IEC added methods, interfaces, inheritance and references in the 3rd: it refuses the first METHOD, EXTENDS or REF_TO it meets. STruC++ (3rd edition) builds it'

/** The same limit, for a `rejects` case. */
const OOP_REJECT_UNCHECKABLE =
  'MATIEC refuses this program before reaching the rule it is about, because it has no object orientation at all, so its rejection says nothing about the rule; STruC++ is not the strictness oracle (see scripts/oracle-strucpp.mjs). The rule is checked in-process, through both engines and the emitted TypeScript'

/** Why the interface-variable cases reach no external compiler, as measured. */
const OOP_IFACE_UNCHECKABLE =
  'no external compiler here has interface VARIABLES. STruC++ 0.6.2 has interfaces as signatures a block IMPLEMENTS, but refuses an instance assigned to a variable of one ("Cannot assign BELT to IDRIVE") and crashes when one is the input of a block; MATIEC has no object orientation. The goldens are checked in-process, through both engines and the emitted TypeScript'

/** Why a ladder case reaches no ST oracle: MATIEC and STruC++ read text, and LADDER is only this engine's text. */
const LADDER_TEXT =
  "LADDER ... END_LADDER is this engine's text for a ladder diagram; IEC gives LD no text, so an ST compiler never reads one. Exported, a rung is the ST it lowers to (the same text the engine ran), which the ST cases already hold to MATIEC; the ladder itself is exported as a PLCopen <LD> body"

export const CONFORMANCE_GROUPS: CaseGroup[] = [
  {
    title: 'integer arithmetic is faithful to declared width',
    cases: [
      {
        // fixed-width two's-complement wrap on overflow, no overflow trap (IEC leaves overflow open; wrapping is
        // this engine's rule); one case per width
        // Signed AND unsigned, one per width. No BYTE/WORD/DWORD: those are
        // ANY_BIT, and IEC does not do arithmetic on a bit string at all (see the rejects
        // case below) - the unsigned integers are their ANY_NUM counterparts.
        name: 'overflow wraps two\'s-complement at each width',
        src: `VAR si : SINT := 127; i : INT := 32767; di : DINT := 2147483647;
usi : USINT := 255; ui : UINT := 65535; udi : UDINT := 4294967295;
rsi : SINT; ri : INT; rdi : DINT; rusi : USINT; rui : UINT; rudi : UDINT; END_VAR
rsi := si + 1; ri := i + 1; rdi := di + 1; rusi := usi + 1; rui := ui + 1; rudi := udi + 1;`,
        steps: [{ expect: { rsi: -128, ri: -32768, rdi: -2147483648, rusi: 0, rui: 0, rudi: 0 } }],
      },
      {
        // No IEC compiler accepts arithmetic on a bit string: arithmetic is ANY_NUM,
        // BYTE/WORD/DWORD are ANY_BIT, so accepting it would build here and on no target.
        name: 'rejects arithmetic on a bit string',
        src: 'VAR b : BYTE := 255; r : BYTE; END_VAR\nr := b + 1;',
        steps: [],
        rejects: /\+ is arithmetic; 'BYTE' is a bit string/,
      },
      {
        // the mirror: bitwise/complement is ANY_BIT, so a signed integer is not an operand
        name: 'rejects a bitwise operation on a number',
        src: 'VAR i : INT := 1; j : INT := 2; r : INT; END_VAR\nr := i AND j;',
        steps: [],
        rejects: /AND is a bit-string operation; 'INT' is a number/,
      },
      {
        // 32-bit multiply must wrap exactly (10^10 mod 2^32 = 1410065408), not lose
        // precision through the f64 product
        name: 'DINT multiply wraps mod 2^32 exactly',
        src: 'VAR big : DINT := 100000; prod : DINT; END_VAR\nprod := big * big;',
        steps: [{ expect: { prod: 1410065408 } }],
      },
      {
        // IEC integer division truncates toward zero; MOD takes the dividend's sign
        // (A MOD B = A - (A/B)*B with truncating division)
        name: 'division truncates toward zero; MOD follows the dividend sign',
        src: `VAR q1 : INT; q2 : INT; m1 : INT; m2 : INT; END_VAR
q1 := -7 / 2; q2 := 7 / 2; m1 := -7 MOD 2; m2 := 7 MOD -2;`,
        steps: [{ expect: { q1: -3, q2: 3, m1: -1, m2: 1 } }],
      },
      {
        // negating INT_MIN has no positive counterpart - wraps back to itself
        // (two's-complement artifact, same as C and PLC hardware)
        name: 'negating INT_MIN wraps to INT_MIN',
        src: 'VAR m : INT := -32768; n : INT; END_VAR\nn := -m;',
        steps: [{ expect: { n: -32768 } }],
      },
      {
        // controllers disagree on integer division by zero: some log a fault and run on,
        // S7-1500's MOD returns 0. This
        // engine faults the scan, so the mistake shows in the sim instead of a made-up value
        name: 'integer division by zero faults the scan',
        src: 'VAR_INPUT n : INT; END_VAR VAR x : INT; END_VAR\nx := 10 / n;',
        steps: [{ in: { n: 0 }, throws: /division by zero/ }],
        oracle: { skip: 'a scan fault has no comparable image: MATIEC-generated C divides by zero (SIGFPE / UB), it does not raise something the harness can read back' },
      },
      {
        name: 'integer MOD by zero faults the scan',
        src: 'VAR_INPUT n : INT; END_VAR VAR x : INT; END_VAR\nx := 10 MOD n;',
        steps: [{ in: { n: 0 }, throws: /MOD by zero/ }],
        oracle: { skip: 'same as integer division by zero - the fault is not observable in the generated C' },
      },
    ],
  },
  {
    title: 'literal typing and mixed-width expressions',
    cases: [
      {
        // `0` and `1` are Boolean literals in IEC, alongside FALSE and TRUE. The standard's own
        // Annex F examples declare `Q : BOOL := 0` and then assign `Q := 1`.
        // Only a bare literal counts: `INT#1` is a typed integer, and a variable of integer type
        // still needs a conversion written (the `rejects` case below holds that line).
        name: '0 and 1 are BOOL literals, as initialisers and as stores',
        src: `VAR_INPUT go : BOOL; END_VAR
VAR_OUTPUT q : BOOL := 0; r : BOOL := 1; both : BOOL; END_VAR
IF go THEN q := 1; ELSE q := 0; END_IF;
both := q AND r;`,
        steps: [
          { expect: { q: false, r: true, both: false } },
          { in: { go: true }, expect: { q: true, r: true, both: true } },
        ],
      },
      {
        // the line the rule above must not cross: 2 is not a Boolean literal in any edition
        name: 'rejects an integer that is not 0 or 1 stored into a BOOL',
        src: 'VAR q : BOOL; END_VAR\nq := 2;',
        steps: [],
        rejects: /cannot assign \w+ to 'q' of type BOOL/,
      },
      {
        // an untyped literal takes the smallest standard type that holds it, so
        // large-literal arithmetic never wraps at INT width
        name: 'large literals compute at their natural width',
        src: 'VAR x : DINT; y : DINT; END_VAR\nx := 40000 + 0;\ny := -40000;',
        steps: [{ expect: { x: 40000, y: -40000 } }],
      },
      {
        // IEC names IEC 60559 for both real types: REAL is binary32, LREAL is binary64.
        // 0.1 + 0.2 is the shortest program that can tell them apart, because neither addend
        // is exact in binary and the two widths part company in the 8th significant digit.
        // Both goldens are the IEEE-754 answers rather than an implementation's: 0.1 + 0.2 is
        // 0.3000000000000000444... in binary64 and 0.300000011920928955... in binary32, each
        // written here at its shortest round-tripping form.
        //
        // The literal typing matters, which is why the case lives in this group: an
        // untyped real literal takes the declared type of what it initialises, and that is
        // what holds the REAL half at single precision. Widening a REAL result to LREAL
        // afterwards cannot recover a digit already discarded, so the wide half only means
        // something because its operands are LREAL from the start.
        name: 'REAL is binary32 and LREAL is binary64',
        src: `VAR wa : LREAL := 0.1; wb : LREAL := 0.2; na : REAL := 0.1; nb : REAL := 0.2; END_VAR
VAR_OUTPUT wide : LREAL; narrow : REAL; END_VAR
wide := wa + wb; narrow := na + nb;`,
        steps: [{ expect: { wide: 0.30000000000000004, narrow: 0.30000001192092896 } }],
      },
      {
        // mixed-width arithmetic widens to the larger operand before wrapping
        name: 'INT + DINT computes at DINT width',
        src: 'VAR i : INT := 32767; d : DINT := 1; r : DINT; END_VAR\nr := i + d;',
        steps: [{ expect: { r: 32768 } }],
        oracle: { editionReject: 'IEC 2nd edition requires both operands of an arithmetic operator to have the same type, and MATIEC enforces that ("Data type mismatch for \'+\' expression"). 3rd edition defines implicit conversions, which widen INT into DINT here.' },
      },
      {
        divergence: 'IEC does not define mixing signed with unsigned at all; our rule is that the UNSIGNED type wins the same-width tie, in either operand order, so the result is deterministic. (Bit strings no longer take part: arithmetic on ANY_BIT is rejected outright, which is what removed the other half of this divergence.)',
        name: 'same-width signed/unsigned ties resolve unsigned, both orders',
        src: `VAR ud : UDINT := 4294967295; di : DINT := 0; sb : SINT := -1; usb : USINT := 0;
a : LREAL; b : LREAL; c : USINT; d : USINT; END_VAR
a := ud + di; b := di + ud; c := usb + sb; d := sb + usb;`,
        steps: [{ expect: { a: 4294967295, b: 4294967295, c: 255, d: 255 } }],
        oracle: { skip: 'a strict IEC compiler rejects the mixed signed/unsigned operands outright, so there is no external answer to compare against' },
      },
    ],
  },
  {
    title: 'conversions round and reinterpret per IEC',
    cases: [
      {
        // REAL->int rounds to nearest, ties to even (IEC REAL_TO_INT is "round to nearest")
        name: 'REAL_TO_INT rounds ties-to-even',
        src: `VAR a : INT; b : INT; c : INT; d : INT; e : INT; f : INT; END_VAR
a := REAL_TO_INT(2.5); b := REAL_TO_INT(3.5); c := REAL_TO_INT(0.5);
d := REAL_TO_INT(2.7); e := REAL_TO_INT(-2.7); f := REAL_TO_INT(-2.5);`,
        steps: [{ expect: { a: 2, b: 4, c: 0, d: 3, e: -3, f: -2 } }],
      },
      {
        // the same rule for the other widths and for LREAL, which the OpenPLC v4 export warning names too
        // (export.ts strucppWarnings): from variables, so a strict compiler has no literal to type
        name: 'every REAL-to-integer conversion rounds a tie to even',
        src: `VAR r1 : REAL := 2.5; r2 : REAL := -3.5; r3 : REAL := 4.5; r4 : REAL := 5.5; l1 : LREAL := 6.5; END_VAR
VAR_OUTPUT d : DINT; dn : DINT; s : SINT; u : UINT; ld : DINT; END_VAR
d := REAL_TO_DINT(r1); dn := REAL_TO_DINT(r2); s := REAL_TO_SINT(r3); u := REAL_TO_UINT(r4); ld := LREAL_TO_DINT(l1);`,
        steps: [{ expect: { d: 2, dn: -4, s: 4, u: 6, ld: 6 } }],
      },
      {
        // IEC has no implicit narrowing: the author has to say which conversion they meant,
        // because REAL->INT could round or truncate and the two disagree at every .5
        name: 'an implicit REAL->INT narrowing is rejected',
        src: 'VAR a : INT; END_VAR\na := 2.5;',
        steps: [],
        rejects: /cannot assign REAL to 'a' of type INT/,
      },
      {
        name: 'an explicit REAL_TO_INT narrowing is accepted',
        src: 'VAR b : INT; END_VAR\nb := REAL_TO_INT(2.5);',
        steps: [{ expect: { b: 2 } }],
      },
      {
        // widening the other way needs no ceremony - IEC 3rd edition allows it implicitly
        name: 'implicit widening up a signed chain and into a real is accepted',
        src: 'VAR s : SINT := 100; i : INT; d : DINT; r : REAL; END_VAR\ni := s;\nd := i;\nr := d;',
        steps: [{ expect: { i: 100, d: 100, r: 100 } }],
        oracle: { editionReject: 'IEC 2nd edition has no implicit conversions at all, so MATIEC refuses every one of these stores ("Incompatible data types for \':=\' operation"). 3rd edition defines the widening set, and every vendor toolchain performs it.' },
      },
      {
        // TRUNC drops the fraction toward zero (distinct from the rounding conversion)
        name: 'TRUNC truncates toward zero',
        src: 'VAR a : DINT; b : DINT; END_VAR\na := TRUNC(2.9);\nb := TRUNC(-2.9);',
        steps: [{ expect: { a: 2, b: -2 } }],
      },
      {
        // int->int conversion reinterprets the low bits (two's-complement wrap)
        name: 'DINT_TO_INT reinterprets the low 16 bits',
        src: 'VAR d : DINT := 40000; i : INT; END_VAR\ni := DINT_TO_INT(d);',
        steps: [{ expect: { i: -25536 } }],
      },
      {
        // anything -> BOOL is `<> 0`; BOOL -> number is 0/1
        name: 'BOOL conversions are <>0 / 0-1',
        src: `VAR a : BOOL; b : BOOL; c : INT; END_VAR
a := INT_TO_BOOL(0); b := INT_TO_BOOL(-5); c := BOOL_TO_INT(TRUE);`,
        steps: [{ expect: { a: false, b: true, c: 1 } }],
      },
      {
        // BCD is an encoding carried in a bit string, one decimal digit per nibble: 123 is 16#0123 = 291, not
        // 16#7B. A round trip alone cannot catch the two readings being confused (a no-op BCD round-trips
        // perfectly), so the packed form is asserted as a number too. 16#99 is the largest two-digit BCD byte, 153
        // read as plain binary.
        //
        // The standard contradicts itself on the spelling. IEC's normative conversion table defines the BCD
        // family over unsigned integers (packed BCD has no sign, which is why this engine's encoder returns 0 for a
        // negative input): BCD_TO_USINT / _UINT / _UDINT and their reverses. IEC's own Annex F examples use the
        // signed spelling: `WEIGH` is `INT_TO_BCD(BCD_TO_INT(gross_weight) - tare_weight)`, and `GRAVEL` does the
        // same with a BCD BYTE. scripts/oracle-import.mjs replays both files.
        //
        // The two compilers differ on it:
        //   - MATIEC implements the table and has neither name. Measured, it cannot compile AnnexF/weigh_st.txt,
        //     a file vendored in its own repository, failing with the same syntax error this case gets.
        //   - STruC++ 0.6.2 compiles this program.
        // By docs/st-conformance.md that is an oracle-side difference, so this is an editionReject rather than a
        // skip, checked both ways on every push (MATIEC must keep refusing, STruC++ must keep building). The field
        // is named for the edition split it usually marks. Here it is a table-versus-annex split within one
        // edition, but the mechanism is the same.
        name: 'the BCD pair packs one decimal digit per nibble',
        src: `VAR n : INT := 123; edge : WORD := 16#99; packed : WORD; back : INT; nines : INT; END_VAR
packed := INT_TO_BCD(n); back := BCD_TO_INT(packed); nines := BCD_TO_INT(edge);`,
        steps: [{ expect: { packed: 291, back: 123, nines: 99 } }],
        oracle: {
          editionReject:
            "IEC's normative conversion table defines BCD over UNSIGNED integers (BCD_TO_UINT and siblings) and MATIEC implements exactly that, so it refuses these names - to the point of being unable to compile the Annex F examples vendored in its own repo. IEC's Annex F itself uses the SIGNED spelling this engine follows (WEIGH: `INT_TO_BCD(BCD_TO_INT(gross_weight) - tare_weight)`), and STruC++ 0.6.2 compiles it. The rejection is the expected answer here, not a portability defect.",
        },
      },
    ],
  },
  {
    title: 'bit-string operations work on the declared width',
    cases: [
      {
        // `&` is IEC's alternative spelling for AND - both are in the standard's operator table,
        // and its own Annex F examples use it. It lexes to an AND keyword, so it works wherever
        // AND does: on BOOLs and on a bit string alike, at the same precedence.
        // 12 & 10 = 2#1100 AND 2#1010 = 2#1000 = 8.
        name: '& is AND, on Booleans and on bit strings',
        src: `VAR_INPUT a : BOOL; b : BOOL; END_VAR
VAR x : BYTE := 12; y : BYTE := 10; END_VAR
VAR_OUTPUT amp : BOOL; masked : BYTE; spelled : BOOL; END_VAR
amp := a & b;
masked := x & y;
spelled := a AND b;`,
        steps: [
          { in: { a: true, b: true }, expect: { amp: true, masked: 8, spelled: true } },
          { in: { a: true, b: false }, expect: { amp: false, masked: 8, spelled: false } },
        ],
      },
      {
        // `NOT 0` stays: an untyped literal has no type of its own and adopts the WORD it
        // is stored into, which MATIEC accepts too. What left is `NOT anInt` - NOT is
        // ANY_BIT, and a signed integer is not a bit string.
        name: 'AND/OR/XOR on bit-strings are bitwise; NOT complements within the width',
        src: `VAR f : WORD := 12; m : WORD := 10; a : WORD; o : WORD; x : WORD; nw : WORD; nm : WORD; END_VAR
a := f AND m; o := f OR m; x := f XOR m; nw := NOT 0; nm := NOT m;`,
        steps: [{ expect: { a: 8, o: 14, x: 6, nw: 65535, nm: 65525 } }],
      },
      {
        name: 'rejects NOT on a number',
        src: 'VAR i : INT := 1; r : INT; END_VAR\nr := NOT i;',
        steps: [],
        rejects: /NOT is a bit-string operation; 'INT' is a number/,
      },
      {
        // IEC SHL/SHR are logical (zero-filled) within the operand's width; shifting the
        // whole width out leaves 0. SHR on a negative INT is logical, not arithmetic.
        // the "is SHR arithmetic or logical?" question does not arise in IEC: SHR takes a
        // bit string, which has no sign, so it is always zero-filled. `SHR(anInt, 1)` is
        // not a shift with a debatable answer, it is a type error.
        name: 'SHL/SHR are logical and width-bounded',
        src: `VAR w : WORD := 1; all : WORD := 65535; a : WORD; b : WORD; c : WORD; END_VAR
a := SHL(w, 15); b := SHL(w, 16); c := SHR(all, 1);`,
        steps: [{ expect: { a: 32768, b: 0, c: 32767 } }],
      },
      {
        name: 'rejects a shift of a signed integer',
        src: 'VAR i : INT := -1; r : INT; END_VAR\nr := SHR(i, 1);',
        steps: [],
        rejects: /'SHR' shifts a bit string; 'INT' is a number/,
      },
      {
        // rotates wrap the evicted bits around the width window
        name: 'ROL/ROR rotate within the width',
        src: `VAR bt : BYTE := 129; w : WORD := 1; a : BYTE; b : WORD; END_VAR
a := ROL(bt, 1); b := ROR(w, 1);`,
        steps: [{ expect: { a: 3, b: 32768 } }],
      },
      {
        // The 32-bit width, which BYTE and WORD cannot stand in for. Every JavaScript bitwise
        // operator coerces its operands to a signed int32, so on a JS host `~0` is -1 and
        // `1 << 31` is -2147483648 - both wrong for an unsigned IEC bit string, and both
        // invisible at the narrower widths because there the sign bit is never reached.
        // The initialisers are typed literals (`DWORD#16#...`): whether an untyped
        // based literal above DINT range adopts DWORD is a separate question, and this case
        // is about the operators, not about literal typing.
        name: 'bit-string operations hold their width at DWORD',
        src: `VAR d : DWORD := DWORD#16#F0F0F0F0; m : DWORD := DWORD#16#FFFF0000; one : DWORD := 1; hi : DWORD := DWORD#16#80000001;
a : DWORD; o : DWORD; x : DWORD; n : DWORD; s : DWORD; rl : DWORD; END_VAR
a := d AND m; o := d OR m; x := d XOR m; n := NOT d; s := SHL(one, 31); rl := ROL(hi, 1);`,
        steps: [{ expect: { a: 4042260480, o: 4294963440, x: 252702960, n: 252645135, s: 2147483648, rl: 3 } }],
      },
      {
        // One bit of a word written in place: the word is rewritten with that bit set or cleared and
        // the others kept. The word may be an array element, which the emitter must not write
        // as `elemAt(..) = v`, a store JavaScript refuses at run time; bit 31 is the DWORD sign bit,
        // which a signed JS `|` would turn negative.
        name: 'a bit write rewrites only that bit, of a variable or an array element',
        src: `VAR set : BOOL := TRUE; i : INT := 2; w : WORD; arr : ARRAY[1..3] OF DWORD; e1 : DWORD; e2 : DWORD; top : BOOL; END_VAR
w.%X3 := set;
arr[i].%X31 := TRUE;
arr[i].%X0 := set;
arr[1].%X4 := set;
e1 := arr[1]; e2 := arr[2]; top := arr[i].%X31;`,
        steps: [
          { expect: { w: 8, e1: 16, e2: 2147483649, top: true } },
          { in: { set: false }, expect: { w: 0, e1: 0, e2: 2147483648, top: true } },
        ],
        oracle: { skip: 'partial access (`.%Xn`) is an IEC 3rd-edition feature, which MATIEC, a 2nd-edition compiler, does not read; not yet replayed on STruC++, so the goldens are checked in-process, through both backends' },
      },
    ],
  },
  {
    title: 'operator precedence (IEC table: OR < XOR < AND < compare < add < mul)',
    cases: [
      {
        name: 'boolean precedence: AND > XOR > OR',
        src: `VAR a : BOOL; b : BOOL; c : BOOL; END_VAR
a := TRUE OR TRUE AND FALSE;
b := TRUE XOR TRUE AND TRUE;
c := FALSE XOR TRUE OR TRUE;`,
        // a: OR(TRUE, AND(TRUE,FALSE)) = TRUE; b: XOR(TRUE, AND(TRUE,TRUE)) = FALSE;
        // c: OR(XOR(FALSE,TRUE), TRUE) = TRUE
        steps: [{ expect: { a: true, b: false, c: true } }],
      },
      {
        // Operand evaluation, not precedence: both operands of a BOOL AND / OR are evaluated, so a
        // guard does not protect what follows it. IEC leaves operand evaluation open. MATIEC compiles a
        // BOOL AND to C `&&` (.oracle/*/POUS.c) and skips the divide. This engine evaluates both and
        // faults, for the reason in the divergence below.
        //
        // The external replay does see this, by shape rather than by value. A `throws` step is dropped
        // from the comparison (oracle-matiec.mjs `runnable`), so no scan line is expected from a run
        // that should fault, while MATIEC's binary completes the scan and prints one. `npm run
        // st-oracle` reports "expected 0 scan lines, got 1" against the divergence below and stays
        // green, which is the intended result for a recorded divergence.
        name: 'both operands of a BOOL AND are evaluated, so a guard does not protect a divide',
        src: `VAR d : INT := 0; guarded : BOOL; END_VAR
guarded := (d <> 0) AND (100 / d > 1);`,
        steps: [{ throws: /division by zero/ }],
        divergence:
          'This engine evaluates both operands of a BOOL AND / OR, so the guarded divide faults. IEC leaves operand evaluation open, so implementations may differ: MATIEC stops at a decided operand, so this program returns FALSE there instead of faulting. A program whose behaviour depends on the difference is non-portable whichever way a simulator answers, so this engine answers the way that SURFACES it: a guard that silently worked here would stop a target that evaluates both operands.',
      },
      {
        name: 'arithmetic precedence: mul > add > compare',
        src: 'VAR a : INT; b : BOOL; END_VAR\na := 2 + 3 * 4;\nb := 1 + 2 < 4;',
        steps: [{ expect: { a: 14, b: true } }],
      },
    ],
  },
  {
    title: 'control flow',
    cases: [
      {
        name: 'CASE selects single, list, range, and negative labels; else falls through',
        src: `VAR_INPUT n : INT; END_VAR VAR_OUTPUT out : INT; END_VAR
CASE n OF 0: out := 100; 1, 2: out := 200; 3..5: out := 300; -1: out := 400; ELSE out := -1; END_CASE;`,
        steps: [
          { in: { n: 0 }, expect: { out: 100 } },
          { in: { n: 2 }, expect: { out: 200 } },
          { in: { n: 4 }, expect: { out: 300 } },
          { in: { n: -1 }, expect: { out: 400 } },
          { in: { n: 9 }, expect: { out: -1 } },
        ],
      },
      {
        // The bound is evaluated once, at entry: rewriting `n` inside the body does not
        // extend the loop. Shown by writing the variable the bound was read from, which is
        // legal. Writing the control variable is not, and has its own case below.
        //
        // MATIEC disagrees. The divergence note records the measurement and does not claim
        // either side is settled. See the note for what would settle it.
        name: 'FOR evaluates bounds once and owns its iteration',
        src: `VAR n : INT := 3; c : INT; i : INT; END_VAR
c := 0;
FOR i := 1 TO n DO n := 10; c := c + 1; END_FOR;`,
        steps: [{ expect: { c: 3, n: 10 } }],
        divergence:
          'The loop bound is snapshotted at entry here, and BOTH independent IEC compilers whose behaviour could be inspected re-read it every iteration, so this program runs 3 times here and 10 times there. MATIEC: its generated C puts `if (I <= N)` inside the loop, reading the live variable. RuSTy (PLC-lang): its FOR lowering plants the user-written bound expression in the loop\'s exit test rather than a temporary, and says so in its own comment. Neither is provably right: IEC constrains FOR to a count "determined in advance", but no edition text reachable from here says WHEN the final-value expression is evaluated, so where to read it is this engine\'s own rule. Two compilers agreeing is weaker evidence than it looks, since both lower FOR to a C/LLVM-style loop where re-reading is the lazy path. The snapshot is kept anyway: it is what makes the iteration count knowable at entry, which is the property FOR exists for (WHILE is the construct for a condition re-tested each pass), and the only runaway guard here is a count rather than a clock (the interpreter faults a loop after 1,000,000 iterations), so a body that grows its own bound would run a million iterations in one scan before that fault stopped it. Because it cannot be settled, it is not left silent either: exporting a loop whose body writes its own bound now WARNS (export.ts), which is the honest response to a difference nobody can adjudicate.',
      },
      {
        // MATIEC says "Assignment to FOR control variable is not allowed", and IEC agrees: the
        // control variable belongs to the loop. A write here would not steer iteration anyway,
        // but it is refused at compile time.
        name: 'rejects assignment to a FOR control variable',
        src: `VAR k : INT; j : INT; END_VAR
k := 0;
FOR j := 1 TO 3 DO k := k + 1; j := 100; END_FOR;`,
        steps: [],
        rejects: /cannot assign to FOR control variable 'j'/,
      },
      {
        name: 'FOR sums with a descending BY step',
        src: `VAR i : INT; hits : INT; sum : INT; END_VAR
hits := 0; sum := 0;
FOR i := 10 TO 0 BY -2 DO hits := hits + 1; END_FOR;
FOR i := 1 TO 5 DO sum := sum + i; END_FOR;`,
        steps: [{ expect: { hits: 6, sum: 15 } }],
      },
      {
        name: 'WHILE pre-tests; REPEAT post-tests (runs at least once); EXIT leaves the loop',
        src: `VAR i : INT; r : INT; last : INT; k : INT; END_VAR
i := 0; WHILE i < 4 DO i := i + 1; END_WHILE;
r := 0; REPEAT r := r + 1; UNTIL TRUE END_REPEAT;
last := 0;
FOR k := 1 TO 100 DO last := k; IF k = 5 THEN EXIT; END_IF; END_FOR;`,
        steps: [{ expect: { i: 4, r: 1, last: 5 } }],
      },
    ],
  },
  {
    title: 'timers against the IEC timing diagrams (dt = 0.1s scans)',
    cases: [
      {
        // TON: Q rises once IN has been true for PT, falls immediately with IN
        // ET is TIME, so it is counted in milliseconds, the representation every target
        // uses, and the case reaches the oracle as strict IEC.
        // The scan that sees the edge elapses nothing: IEC's body records START_TIME there
        // and measures from the next scan on, so et reads 0 on that scan (MATIEC agrees).
        name: 'TON on-delay',
        src: `VAR_INPUT go : BOOL; END_VAR VAR_OUTPUT q : BOOL; et : TIME; END_VAR VAR t : TON; END_VAR
t(IN := go, PT := T#0.3s); q := t.Q; et := t.ET;`,
        steps: [
          { in: { go: true }, expect: { q: false }, close: { et: 0 } }, // the edge scan starts the clock
          { expect: { q: false }, close: { et: 100 } },
          { expect: { q: false }, close: { et: 200 } },
          { expect: { q: true }, close: { et: 300 } }, // PT reached, and ET holds at PT
          { in: { go: false }, expect: { q: false }, close: { et: 0 } },
        ],
      },
      {
        // A duration is not a number: passing a bare 300 where PT is expected would mean
        // "300 milliseconds" here and would not compile on the target at all.
        name: 'a plain number is rejected where TIME is expected',
        src: `VAR_INPUT go : BOOL; END_VAR VAR t : TON; END_VAR\nt(IN := go, PT := 300);`,
        steps: [],
        rejects: /cannot assign INT to TON input 'PT' of type TIME/,
      },
      {
        // durations add, subtract, scale and compare; they never mix with plain numbers
        name: 'TIME arithmetic adds, scales and compares durations',
        src: `VAR a : TIME := T#1s; b : TIME := T#500ms; sum : TIME; diff : TIME; scaled : TIME; longer : BOOL; END_VAR
sum := a + b; diff := a - b; scaled := b * 3; longer := a > b;`,
        steps: [{ expect: { sum: 1500, diff: 500, scaled: 1500, longer: true } }],
      },
      {
        name: 'adding a plain number to a duration is rejected',
        src: 'VAR a : TIME := T#1s; b : TIME; END_VAR\nb := a + 1;',
        steps: [],
        rejects: /needs both operands to be TIME/,
      },
      {
        // TOF: Q follows IN up immediately, holds for PT after IN falls; no
        // spurious startup pulse when IN was never true
        name: 'TOF off-delay',
        src: `VAR_INPUT go : BOOL; END_VAR VAR_OUTPUT q : BOOL; END_VAR VAR t : TOF; END_VAR
t(IN := go, PT := T#0.2s); q := t.Q;`,
        steps: [
          { expect: { q: false } }, // cold start, IN never true
          { in: { go: true }, expect: { q: true } },
          { in: { go: false }, expect: { q: true } }, // the falling edge starts the clock at 0
          { expect: { q: true } }, // 0.1 < PT
          { expect: { q: false } }, // 0.2 >= PT
        ],
      },
      {
        // TP: a rising edge starts a fixed PT pulse; IN changes during it are ignored
        name: 'TP fixed-width pulse',
        src: `VAR_INPUT go : BOOL; END_VAR VAR_OUTPUT q : BOOL; END_VAR VAR t : TP; END_VAR
t(IN := go, PT := T#0.2s); q := t.Q;`,
        steps: [
          { in: { go: true }, expect: { q: true } },
          { in: { go: false }, expect: { q: true } }, // pulse holds through the IN drop
          { expect: { q: false } }, // PT elapsed
        ],
      },
      {
        // A timer reads the clock: IEC's body measures CURRENT_TIME - START_TIME, so the scans it is not called
        // on still pass. Here it starts on scan 1 and is next called on scan 4, 300 ms of clock later; adding each
        // call's dt instead would read 100 ms there.
        name: 'a TON inside an IF measures the time between calls, not the calls',
        src: `VAR_INPUT look, go : BOOL; END_VAR VAR_OUTPUT q : BOOL; et : TIME; END_VAR VAR t : TON; END_VAR
IF look THEN
  t(IN := go, PT := T#0.3s);
END_IF;
q := t.Q; et := t.ET;`,
        steps: [
          { in: { look: true, go: true }, expect: { q: false }, close: { et: 0 } }, // the edge scan starts the clock
          { in: { look: false }, expect: { q: false }, close: { et: 0 } }, // not called: the outputs hold
          { expect: { q: false }, close: { et: 0 } },
          { in: { look: true }, expect: { q: true }, close: { et: 300 } }, // called again, 300 ms after the edge
          { in: { go: false }, expect: { q: false }, close: { et: 0 } },
        ],
      },
      {
        // the same for the other two: the off-delay and the pulse both start on scan 2 and are next called on
        // scan 5, 300 ms later, which is the whole of their PT
        name: 'a TOF and a TP inside an IF measure the time between calls too',
        src: `VAR_INPUT look, hold, fire : BOOL; END_VAR VAR_OUTPUT off : BOOL; pulse : BOOL; END_VAR VAR d : TOF; p : TP; END_VAR
IF look THEN
  d(IN := hold, PT := T#0.3s);
  p(IN := fire, PT := T#0.3s);
END_IF;
off := d.Q; pulse := p.Q;`,
        steps: [
          { in: { look: true, hold: true }, expect: { off: true, pulse: false } },
          { in: { hold: false, fire: true }, expect: { off: true, pulse: true } }, // the off-delay and the pulse start
          { in: { look: false }, expect: { off: true, pulse: true } }, // not called: the outputs hold
          { expect: { off: true, pulse: true } },
          { in: { look: true }, expect: { off: false, pulse: false } }, // called again: PT has passed for both
        ],
      },
    ],
  },
  {
    title: 'edge detectors, counters and latches',
    cases: [
      {
        // one-shot outputs for exactly the scan after the edge; no pulse at cold start
        divergence: 'the literal IEC F_TRIG body fires when CLK starts false; we suppress that startup pulse, since CLK was never TRUE before it',
        name: 'R_TRIG / F_TRIG single-scan pulses',
        src: `VAR_INPUT clk : BOOL; END_VAR VAR_OUTPUT up : BOOL; dn : BOOL; END_VAR VAR r : R_TRIG; f : F_TRIG; END_VAR
r(CLK := clk); f(CLK := clk); up := r.Q; dn := f.Q;`,
        steps: [
          { expect: { up: false, dn: false } }, // cold start on a low CLK
          { in: { clk: true }, expect: { up: true, dn: false } },
          { expect: { up: false, dn: false } }, // held high
          { in: { clk: false }, expect: { up: false, dn: true } },
          { expect: { up: false, dn: false } }, // held low
        ],
        oracle: { skip: 'the cold-start step is the documented F_TRIG divergence, so an external run is expected to disagree on scan 1 by construction' },
      },
      {
        // The same one-shots, checkable by an external compiler. The case above is withheld
        // because its first scan is the F_TRIG divergence. Starting CLK high avoids that scan
        // without hiding the divergence, so a real compiler checks all five steps.
        //
        // Why a high cold start is safe: IEC's F_TRIG body is `Q := NOT CLK AND NOT M;
        // M := NOT CLK;` with M initialised FALSE, so the literal body's scan 1 answer is
        // `NOT CLK AND TRUE`: a spurious pulse only when CLK starts low. With CLK high it is
        // FALSE, which is what this engine says too. From scan 2 on the two agree by
        // construction: both reduce to `Q = NOT CLK AND CLK_prev`. R_TRIG does not diverge
        // (its M also starts FALSE), so scan 1 is a rising edge, and this case checks that.
        name: 'R_TRIG / F_TRIG pulse once per edge, from a HIGH cold start',
        src: `VAR_INPUT clk : BOOL; END_VAR VAR_OUTPUT up : BOOL; dn : BOOL; END_VAR VAR r : R_TRIG; f : F_TRIG; END_VAR
r(CLK := clk); f(CLK := clk); up := r.Q; dn := f.Q;`,
        steps: [
          { in: { clk: true }, expect: { up: true, dn: false } }, // a high cold start is itself the rising edge
          { expect: { up: false, dn: false } }, // one scan only, then held high
          { in: { clk: false }, expect: { up: false, dn: true } },
          { expect: { up: false, dn: false } }, // held low
          { in: { clk: true }, expect: { up: true, dn: false } }, // the detector re-arms
        ],
      },
      {
        // CTU counts rising edges to Q at PV; R (the IEC spelling) resets
        name: 'CTU counts up and resets on R',
        src: `VAR_INPUT cu : BOOL; rst : BOOL; END_VAR VAR_OUTPUT n : INT; full : BOOL; END_VAR VAR c : CTU; END_VAR
c(CU := cu, R := rst, PV := 2); n := c.CV; full := c.Q;`,
        steps: [
          { in: { cu: true }, expect: { n: 1, full: false } },
          { in: { cu: false }, expect: { n: 1 } },
          { in: { cu: true }, expect: { n: 2, full: true } },
          { in: { cu: false, rst: true }, expect: { n: 0, full: false } },
        ],
      },
      {
        // CTD loads PV on LD, counts down on rising CD, Q at zero, clamps there
        name: 'CTD loads and counts down to zero',
        src: `VAR_INPUT cd : BOOL; ld : BOOL; END_VAR VAR_OUTPUT n : INT; empty : BOOL; END_VAR VAR c : CTD; END_VAR
c(CD := cd, LD := ld, PV := 2); n := c.CV; empty := c.Q;`,
        steps: [
          { in: { ld: true }, expect: { n: 2, empty: false } },
          { in: { ld: false, cd: true }, expect: { n: 1 } },
          { in: { cd: false }, expect: { n: 1 } },
          { in: { cd: true }, expect: { n: 0, empty: true } },
          { in: { cd: false }, expect: { n: 0 } },
          { in: { cd: true }, expect: { n: 0 } }, // clamped at zero
        ],
      },
      {
        name: 'CTUD counts both directions with QU/QD thresholds',
        src: `VAR_INPUT up : BOOL; dn : BOOL; END_VAR VAR_OUTPUT n : INT; qu : BOOL; qd : BOOL; END_VAR VAR c : CTUD; END_VAR
c(CU := up, CD := dn, PV := 2); n := c.CV; qu := c.QU; qd := c.QD;`,
        steps: [
          { expect: { n: 0, qu: false, qd: true } }, // CV starts at 0
          { in: { up: true }, expect: { n: 1, qd: false } },
          { in: { up: false }, expect: { n: 1 } },
          { in: { up: true }, expect: { n: 2, qu: true } },
          { in: { up: false, dn: true }, expect: { n: 1, qu: false } },
        ],
      },
      {
        // IEC's SR body is `Q1 := S1 OR (NOT R AND Q1)`: the set term is OR'd on last, so
        // SET wins when both inputs are true. That tie is the entire difference between SR
        // and RS, and it is the half a hand-rolled seal-in usually gets wrong - which is why
        // both are worth an external witness rather than one standing in for the other.
        // Nothing here needs a cold-start caveat: Q1 starts FALSE in the standard body too.
        name: 'SR latches and is set-dominant',
        src: `VAR_INPUT s : BOOL; r : BOOL; END_VAR VAR_OUTPUT q : BOOL; END_VAR VAR l : SR; END_VAR
l(S1 := s, R := r); q := l.Q1;`,
        steps: [
          { expect: { q: false } }, // cold start, both inputs low
          { in: { s: true }, expect: { q: true } },
          { in: { s: false }, expect: { q: true } }, // holds with both low: this is the memory
          { in: { r: true }, expect: { q: false } },
          { in: { s: true }, expect: { q: true } }, // S1 and R both true -> SET wins
          { in: { s: false }, expect: { q: false } }, // R is still true
        ],
      },
      {
        // IEC's RS body is `Q1 := NOT R1 AND (S OR Q1)`: the reset term gates the result, so
        // RESET wins the tie. The mirror of the case above, stepped through the same
        // sequence so the one scan they disagree on is the one under test.
        name: 'RS latches and is reset-dominant',
        src: `VAR_INPUT s : BOOL; r : BOOL; END_VAR VAR_OUTPUT q : BOOL; END_VAR VAR l : RS; END_VAR
l(S := s, R1 := r); q := l.Q1;`,
        steps: [
          { expect: { q: false } },
          { in: { s: true }, expect: { q: true } },
          { in: { s: false }, expect: { q: true } }, // holds
          { in: { r: true }, expect: { q: false } },
          { in: { s: true }, expect: { q: false } }, // S and R1 both true -> RESET wins
          { in: { r: false }, expect: { q: true } }, // s is still true
        ],
      },
    ],
  },
  {
    title: 'selection and math builtins',
    cases: [
      {
        name: 'MIN/MAX are variadic; LIMIT clamps IN between MN and MX',
        src: `VAR a : INT; b : INT; c : INT; d : INT; END_VAR
a := MIN(3, 1, 2); b := MAX(3, 1, 2); c := LIMIT(0, 5, 3); d := LIMIT(0, -5, 3);`,
        steps: [{ expect: { a: 1, b: 3, c: 3, d: 0 } }],
      },
      {
        // SEL(G, IN0, IN1): G=FALSE selects IN0. MUX(K, ...) selects the K-th (0-based).
        divergence: 'IEC declares an out-of-range MUX selector an error; we return 0',
        name: 'SEL and MUX select; out-of-range MUX yields 0',
        src: `VAR a : INT; b : INT; c : INT; d : INT; END_VAR
a := SEL(FALSE, 10, 20); b := SEL(TRUE, 10, 20); c := MUX(1, 10, 20, 30); d := MUX(9, 10, 20);`,
        steps: [{ expect: { a: 10, b: 20, c: 20, d: 0 } }],
        oracle: { skip: 'the out-of-range MUX step has no defined external answer - IEC calls it an error, so there is nothing to diff against' },
      },
      {
        // The same two selectors, checkable externally. The case above is withheld for one step:
        // the out-of-range MUX, which IEC calls an error and so gives no external answer to diff
        // against. Withholding it would also withhold SEL and every in-range MUX, so the defined
        // behaviour is split out here, as with the R_TRIG pair. The withheld case records the
        // divergence, and this one is checked. MUX is exercised at both ends and the middle,
        // since an off-by-one in the 0-based index is the likely failure.
        name: 'SEL picks by a BOOL, MUX by a 0-based index',
        src: `VAR onfalse : INT; ontrue : INT; first : INT; middle : INT; last : INT; END_VAR
onfalse := SEL(FALSE, 10, 20); ontrue := SEL(TRUE, 10, 20);
first := MUX(0, 10, 20, 30); middle := MUX(1, 10, 20, 30); last := MUX(2, 10, 20, 30);`,
        steps: [{ expect: { onfalse: 10, ontrue: 20, first: 10, middle: 20, last: 30 } }],
      },
      {
        name: 'ABS/SQRT/EXPT on exactly-representable values',
        src: `VAR a : INT; b : REAL; c : REAL; END_VAR
a := ABS(-5); b := SQRT(9.0); c := EXPT(2.0, 10.0);`,
        steps: [{ expect: { a: 5, b: 3, c: 1024 } }],
      },
      {
        // The rest of IEC's REAL math set, at arguments whose answers are known exactly rather
        // than looked up: sin/tan of 0, cos of 0, the arc functions at their axis values, and
        // the two logarithms where they read 0 and 2.
        //
        // LOG matters most here. IEC's LOG is base 10 and LN is natural, and an engine that
        // mixed them up would still pass every "it returned a number" check. So the argument
        // is 100, where the two answers are 2 and 4.6 and no tolerance can confuse them. Compared with `close` because the results are REAL: this engine rounds
        // to f32 after every operation and MATIEC's REAL is a C float, so the last bits are
        // not a promise either side makes.
        //
        // Arguments are declared REAL variables rather than bare literals. Whether an untyped
        // real literal binds to REAL or LREAL at a call site is a different question, with its
        // own case, and should not affect this one.
        name: 'the REAL math set at values with exact answers',
        src: `VAR zero : REAL := 0.0; one : REAL := 1.0; hundred : REAL := 100.0; END_VAR
VAR_OUTPUT sn : REAL; cs : REAL; tn : REAL; asn : REAL; acs : REAL; atn : REAL; nlog : REAL; dlog : REAL; ex : REAL; END_VAR
sn := SIN(zero); cs := COS(zero); tn := TAN(zero);
asn := ASIN(one); acs := ACOS(zero); atn := ATAN(one);
nlog := LN(one); dlog := LOG(hundred); ex := EXP(zero);`,
        steps: [
          {
            close: {
              sn: 0,
              cs: 1,
              tn: 0,
              asn: 1.5707963267948966, // PI/2
              acs: 1.5707963267948966, // PI/2
              atn: 0.7853981633974483, // PI/4
              nlog: 0,
              dlog: 2, // base 10, not natural: LN(100) would be 4.605
              ex: 1,
            },
          },
        ],
      },
      {
        divergence: 'float error handling is vendor-defined; REAL division by zero stays IEEE +/-Infinity here, matching PLC float hardware, which flags but does not fault. Only INTEGER division faults the scan',
        name: 'REAL division by zero yields Infinity, not a fault',
        src: 'VAR r : REAL := 1.0; q : REAL; END_VAR\nq := r / 0.0;',
        steps: [{ expect: { q: Infinity } }],
        oracle: { skip: 'vendor-defined behaviour with no portable spelling for the expected value' },
      },
    ],
  },
  {
    // IEC gives every arithmetic and comparison operator a function spelling as well (ADD(a, b)
    // for a + b, GT(a, b) for a > b). A program generated from a graphical language arrives
    // written that way, because that is what an FBD block becomes.
    //
    // They get their own group because these names are known to behave differently across
    // implementations. docs/st-conformance.md records that a variable may be named `lt` here while
    // MATIEC refuses the declaration, since its lexer is shared with Instruction List, where LT is
    // an operator token. That was measured on the identifier side. These cases cover the call side.
    title: 'the operator functions (IEC call form: ADD, SUB, GT, ...)',
    cases: [
      {
        // IEC makes ADD and MUL extensible (ADD(a,b,c) = a+b+c) while SUB and DIV take exactly
        // two. Subtraction and division are not associative, so a chain would have to pick an
        // order, and the standard does not pick one.
        // DIV on integers is the `/` operator: the quotient truncated toward zero, so 10/3 is 3.
        name: 'ADD and MUL are extensible; SUB and DIV take two',
        src: `VAR a : INT := 10; b : INT := 3; c : INT := 2;
sum2 : INT; sum3 : INT; prod2 : INT; prod3 : INT; less : INT; quot : INT; END_VAR
sum2 := ADD(a, b); sum3 := ADD(a, b, c);
prod2 := MUL(a, b); prod3 := MUL(a, b, c);
less := SUB(a, b); quot := DIV(a, b);`,
        steps: [{ expect: { sum2: 13, sum3: 15, prod2: 30, prod3: 60, less: 7, quot: 3 } }],
      },
      {
        // The comparison functions are chains, not folds: IEC defines
        // GT(IN1,...,INn) as (IN1>IN2) & (IN2>IN3) & ..., so GT(3, 1, 2) is FALSE even though
        // its first and last arguments are in order. That third case is the reason for this one.
        // A two-argument test would pass against an implementation that compared only the ends,
        // or one that folded left.
        //
        // None of the results is named after its function. MATIEC refuses `VAR_OUTPUT lt : BOOL;`,
        // because LT is an Instruction List operator and its lexer is shared. Naming a result `lt`
        // here would fail the gate for a reason unrelated to what the case tests.
        name: 'comparison functions chain their arguments pairwise',
        src: `VAR a : INT := 3; b : INT := 2; c : INT := 1;
above : BOOL; descending : BOOL; unordered : BOOL; atleast : BOOL;
same : BOOL; below : BOOL; upto : BOOL; differs : BOOL; END_VAR
above := GT(a, b); descending := GT(a, b, c); unordered := GT(a, c, b);
atleast := GE(a, a); same := EQ(a, a); below := LT(b, a); upto := LE(a, a); differs := NE(a, b);`,
        steps: [
          {
            expect: {
              above: true,
              descending: true, // 3 > 2 AND 2 > 1
              unordered: false, // 3 > 1 holds, 1 > 2 does not - a fold on the ends would say true
              atleast: true,
              same: true,
              below: true,
              upto: true,
              differs: true,
            },
          },
        ],
      },
      {
        // MOVE is assignment as a function. It is kept apart from the arithmetic case above so
        // that a rejection of MOVE alone cannot withdraw ADD, SUB, MUL and DIV from the gate.
        // Measured, this MATIEC build accepts MOVE, so no editionReject is claimed.
        name: 'MOVE is assignment in function form',
        src: `VAR a : INT := 7; copy : INT; END_VAR
copy := MOVE(a);`,
        steps: [{ expect: { copy: 7 } }],
      },
    ],
  },
  {
    title: 'declarations, jumps and output bindings',
    cases: [
      {
        // A comma-separated name list: IEC's `var1_list ':' simple_spec_init`. It is not a vendor
        // extension. Most of the standard's own Annex F examples use it, and 8 of the 36 real files
        // the import oracle reads need it. Every other case in this corpus declares one variable
        // per line, so without this case nothing here would cover the form.
        //
        // The initialiser is shared by value, not by storage: `x, y, z : INT := 3` gives each of
        // them 3, and writing one must not move the others.
        name: 'one declaration line can name several variables',
        src: `VAR_INPUT a, b : INT; END_VAR
VAR x, y, z : INT := 3; p, q : BOOL := TRUE; END_VAR
VAR_OUTPUT sum : INT; both : BOOL; moved : INT; END_VAR
sum := a + b + x + y + z;
both := p AND q;
x := 100;
moved := y + z;`,
        steps: [{ in: { a: 1, b: 2 }, expect: { sum: 12, both: true, moved: 6 } }],
      },
      {
        // Each name in a list is its own variable, which for a function-block instance means its
        // own retained image. An implementation that shared one would tick both counters here.
        name: 'function-block instances in one list are independent',
        src: `FUNCTION_BLOCK Cnt VAR_OUTPUT n : INT; END_VAR n := n + 1; END_FUNCTION_BLOCK
VAR c1, c2 : Cnt; END_VAR
VAR_OUTPUT ticked : INT; idle : INT; END_VAR
c1();
ticked := c1.n;
idle := c2.n;`,
        steps: [
          { expect: { ticked: 1, idle: 0 } },
          { expect: { ticked: 2, idle: 0 } }, // and the untouched instance stays put across scans
        ],
      },
      {
        // the same rule for an ARRAY initialiser: two arrays, each with its own elements
        name: 'arrays in one list get separate storage, not a shared initialiser',
        src: `VAR u, v : ARRAY[1..3] OF INT := [1, 2, 3]; END_VAR
VAR_OUTPUT changed : INT; untouched : INT; END_VAR
u[1] := 9;
changed := u[1];
untouched := v[1];`,
        steps: [{ expect: { changed: 9, untouched: 1 } }],
      },
      {
        // RETURN ends this POU's scan; it unwinds out of loops rather than being caught
        // by them, which is what distinguishes it from EXIT
        name: 'RETURN ends the scan, from inside a loop too',
        src: `VAR_INPUT stop : BOOL; END_VAR VAR_OUTPUT before : INT; after : INT; inner : INT; END_VAR VAR i : INT; END_VAR
before := before + 1;
FOR i := 1 TO 3 DO
  inner := inner + 1;
  IF stop THEN RETURN; END_IF;
END_FOR;
after := after + 1;`,
        steps: [
          { expect: { before: 1, inner: 3, after: 1 } },
          { in: { stop: true }, expect: { before: 2, inner: 4, after: 1 } }, // stopped mid-loop
        ],
      },
      {
        // CONTINUE skips the rest of the body; the loop itself carries on
        name: 'CONTINUE skips to the next iteration',
        src: `VAR i : INT; END_VAR VAR_OUTPUT odd : INT; seen : INT; END_VAR
FOR i := 1 TO 6 DO
  seen := seen + 1;
  IF i MOD 2 = 0 THEN CONTINUE; END_IF;
  odd := odd + 1;
END_FOR;`,
        steps: [{ expect: { seen: 6, odd: 3 } }],
      },
      {
        // `=>` binds an output back into a place after the call, the IEC 3rd-edition
        // spelling most real ST is written in
        name: 'an output binding writes the member back after the call',
        src: `VAR_INPUT go : BOOL; END_VAR VAR_OUTPUT done : BOOL; elapsed : TIME; END_VAR VAR t : TON; END_VAR
t(IN := go, PT := T#0.2s, Q => done, ET => elapsed);`,
        steps: [
          { in: { go: true }, expect: { done: false }, close: { elapsed: 0 } },
          { expect: { done: false }, close: { elapsed: 100 } },
          { expect: { done: true }, close: { elapsed: 200 } },
        ],
      },
      {
        name: 'a CONSTANT is readable and cannot be assigned',
        src: 'VAR CONSTANT Rate : INT := 7; END_VAR VAR_OUTPUT total : INT; END_VAR\ntotal := total + Rate;',
        steps: [{ expect: { total: 7 } }, { expect: { total: 14 } }],
      },
      {
        name: 'assigning to a CONSTANT is rejected',
        src: 'VAR CONSTANT Rate : INT := 7; END_VAR\nRate := 8;',
        steps: [],
        rejects: /cannot assign to CONSTANT 'Rate'/,
      },
      {
        name: 'an array initializer fills the array, with n(x) repetition',
        src: `VAR a : ARRAY[1..5] OF INT := [1, 2, 3(9)]; i : INT; END_VAR VAR_OUTPUT sum : INT; last : INT; END_VAR
sum := 0;
FOR i := 1 TO 5 DO sum := sum + a[i]; END_FOR;
last := a[5];`,
        steps: [{ expect: { sum: 30, last: 9 } }],
      },
      {
        // one image, shared: the function block writes it and the program reads it back
        name: 'a VAR_GLOBAL is one image shared by every POU',
        src: `VAR_GLOBAL Level : INT; END_VAR
FUNCTION_BLOCK Filler VAR_INPUT step : INT; END_VAR Level := Level + step; END_FUNCTION_BLOCK
VAR f : Filler; END_VAR VAR_OUTPUT seen : INT; END_VAR
f(step := 5);
seen := Level;`,
        steps: [{ expect: { seen: 5 } }, { expect: { seen: 10 } }],
        oracle: { skip: 'strict IEC makes a POU declare VAR_EXTERNAL to reach a VAR_GLOBAL; here every POU sees globals directly, so MATIEC rejects the FB that writes Level without one. A documented permissiveness, not a semantic difference' },
      },
      {
        name: 'a missing statement separator is rejected',
        // (not after END_IF: a program here may leave that one out, a tolerated input form - parserStmt.ts `blockEnd`)
        src: 'VAR a : INT; END_VAR\nIF TRUE THEN a := 1 END_IF;\na := 2;',
        steps: [],
        rejects: /expected ';'/,
      },
    ],
  },
  {
    title: 'POUs - functions are stateless, function blocks retain state',
    cases: [
      {
        name: 'a FUNCTION starts from zeroed locals on every call',
        src: `FUNCTION Inc : INT VAR_INPUT v : INT; END_VAR VAR tmp : INT; END_VAR tmp := tmp + v; Inc := tmp; END_FUNCTION
VAR_OUTPUT a : INT; b : INT; END_VAR
a := Inc(5); b := Inc(5);`,
        steps: [
          { expect: { a: 5, b: 5 } },
          { expect: { a: 5, b: 5 } }, // and across scans
        ],
      },
      {
        name: 'functions compose (nested calls evaluate inside-out)',
        src: `FUNCTION Dbl : INT VAR_INPUT v : INT; END_VAR Dbl := v * 2; END_FUNCTION
FUNCTION Quad : INT VAR_INPUT v : INT; END_VAR Quad := Dbl(Dbl(v)); END_FUNCTION
VAR_INPUT n : INT; END_VAR VAR_OUTPUT r : INT; END_VAR
r := Quad(n);`,
        steps: [{ in: { n: 3 }, expect: { r: 12 } }],
      },
      {
        name: 'a FUNCTION_BLOCK instance retains its image across scans',
        src: `FUNCTION_BLOCK Cnt VAR_OUTPUT n : INT; END_VAR n := n + 1; END_FUNCTION_BLOCK
VAR c : Cnt; END_VAR VAR_OUTPUT total : INT; END_VAR
c(); total := c.n;`,
        steps: [{ expect: { total: 1 } }, { expect: { total: 2 } }, { expect: { total: 3 } }],
      },
      {
        // Comments, which no other case in this corpus carries. The engine never sees them (the
        // lexer drops them before the parser runs), but the exporter is a syntactic pass over raw
        // source and does. A comment above a POU must not hide the POU from the block splitter,
        // or the rendered program nests a FUNCTION_BLOCK inside PROGRAM ... END_PROGRAM, which
        // no compiler accepts. Commenting an FB header is common, so the corpus needs this case.
        //
        // The comment naming END_FUNCTION_BLOCK is deliberate: a terminator mentioned in
        // prose must not end the block. `(* *)` only - `//` is a 3rd-edition spelling and
        // this case has to compile under the 2nd-edition oracle as well.
        name: 'comments around a POU do not change the program',
        src: `(* a counter: one tick per scan *)
FUNCTION_BLOCK Cnt (* no inputs *)
VAR_OUTPUT n : INT; END_VAR
(* END_FUNCTION_BLOCK closes this, below *)
n := n + 1;
END_FUNCTION_BLOCK
VAR c : Cnt; END_VAR VAR_OUTPUT total : INT; END_VAR
c(); total := c.n; (* the running count *)`,
        steps: [{ expect: { total: 1 } }, { expect: { total: 2 } }],
      },
      {
        name: 'structs and arrays hold their element image through loops',
        src: `TYPE Pt : STRUCT x : INT; y : INT; END_STRUCT; END_TYPE
VAR p : Pt; a : ARRAY[1..3] OF INT; s : INT; i : INT; END_VAR
p.x := 2; p.y := 3;
a[1] := p.x; a[2] := p.y; a[3] := p.x * p.y;
s := 0;
FOR i := 1 TO 3 DO s := s + a[i]; END_FOR;`,
        steps: [{ expect: { s: 11 } }],
      },
    ],
  },
  {
    // A function-block instance is data, so it can live wherever data lives: an array element, a
    // struct field, a VAR_GLOBAL. Real conveyor code is written in exactly these shapes (a
    // debounce timer per photo-eye, a gap timer per zone). The goldens follow the TON timing
    // already pinned above: the edge scan elapses nothing.
    title: 'function-block instances live in arrays, structs and globals',
    cases: [
      {
        // each element is its own instance: two timers started a scan apart stay a scan apart,
        // and resetting one does not touch the other
        name: 'an array of timers keeps one clock per element',
        src: `VAR_INPUT e1 : BOOL; e2 : BOOL; END_VAR
VAR_OUTPUT q1 : BOOL; q2 : BOOL; et1 : TIME; et2 : TIME; END_VAR
VAR d : ARRAY [1..2] OF TON; eyes : ARRAY [1..2] OF BOOL; i : INT; END_VAR
eyes[1] := e1; eyes[2] := e2;
FOR i := 1 TO 2 DO d[i](IN := eyes[i], PT := T#0.2s); END_FOR;
q1 := d[1].Q; q2 := d[2].Q; et1 := d[1].ET; et2 := d[2].ET;`,
        steps: [
          { in: { e1: true }, expect: { q1: false, q2: false }, close: { et1: 0, et2: 0 } }, // d[1]'s edge scan
          { in: { e2: true }, expect: { q1: false, q2: false }, close: { et1: 100, et2: 0 } }, // d[2]'s edge scan
          { expect: { q1: true, q2: false }, close: { et1: 200, et2: 100 } },
          { in: { e1: false }, expect: { q1: false, q2: true }, close: { et1: 0, et2: 200 } }, // d[1] resets alone
        ],
        oracle: { skip: FB_ARRAY_UNCHECKABLE },
      },
      {
        // a timer and a counter as struct fields, called and read through the field path
        name: 'function blocks inside a struct are called and read through their fields',
        src: `TYPE Zone : STRUCT gap : TON; count : CTU; END_STRUCT; END_TYPE
VAR_INPUT eye : BOOL; END_VAR
VAR_OUTPUT open : BOOL; boxes : INT; END_VAR
VAR z : Zone; END_VAR
z.gap(IN := NOT eye, PT := T#0.2s);
z.count(CU := eye, R := FALSE, PV := 100);
open := z.gap.Q; boxes := z.count.CV;`,
        steps: [
          { expect: { open: false, boxes: 0 } }, // the gap timer's edge scan
          { expect: { open: false, boxes: 0 } },
          { expect: { open: true, boxes: 0 } }, // 200 ms of gap
          { in: { eye: true }, expect: { open: false, boxes: 1 } }, // a box arrives: gap resets, count rises
          { in: { eye: false }, expect: { open: false, boxes: 1 } },
          { in: { eye: true }, expect: { open: false, boxes: 2 } },
        ],
        oracle: { editionReject: 'MATIEC (2nd edition) has no function-block instances as struct fields and refuses the TYPE ("invalid specification in structure element declaration"). STruC++ (3rd edition) builds it, call and all.' },
      },
      {
        // user blocks in an array, called by index with an output binding into another array
        name: 'an array of user function blocks, called by index with output bindings',
        src: `FUNCTION_BLOCK Zone
VAR_INPUT eye : BOOL; END_VAR
VAR_OUTPUT run : BOOL; seen : INT; END_VAR
run := NOT eye;
IF eye THEN seen := seen + 1; END_IF;
END_FUNCTION_BLOCK
VAR_INPUT b2 : BOOL; END_VAR
VAR_OUTPUT run1 : BOOL; run2 : BOOL; run3 : BOOL; seen2 : INT; END_VAR
VAR zones : ARRAY [1..3] OF Zone; eyes : ARRAY [1..3] OF BOOL; runs : ARRAY [1..3] OF BOOL; k : INT; END_VAR
eyes[2] := b2;
FOR k := 1 TO 3 DO zones[k](eye := eyes[k], run => runs[k]); END_FOR;
run1 := runs[1]; run2 := runs[2]; run3 := runs[3]; seen2 := zones[2].seen;`,
        steps: [
          { in: { b2: true }, expect: { run1: true, run2: false, run3: true, seen2: 1 } },
          { expect: { run1: true, run2: false, run3: true, seen2: 2 } }, // zones[2] retains its own count
          { in: { b2: false }, expect: { run1: true, run2: true, run3: true, seen2: 2 } },
        ],
        oracle: { skip: FB_ARRAY_UNCHECKABLE },
      },
      {
        // a block holding an array of timers, fed through VAR_IN_OUT so it reads the caller's
        // array in place
        name: 'a function block holds an array of timers of its own',
        src: `FUNCTION_BLOCK Debounce
VAR_IN_OUT raw : ARRAY [1..2] OF BOOL; END_VAR
VAR_OUTPUT held : BOOL; END_VAR
VAR t : ARRAY [1..2] OF TON; i : INT; END_VAR
held := FALSE;
FOR i := 1 TO 2 DO
  t[i](IN := raw[i], PT := T#0.1s);
  held := held OR t[i].Q;
END_FOR;
END_FUNCTION_BLOCK
VAR_INPUT a : BOOL; END_VAR
VAR_OUTPUT steady : BOOL; END_VAR
VAR db : Debounce; eyes : ARRAY [1..2] OF BOOL; END_VAR
eyes[2] := a;
db(raw := eyes, held => steady);`,
        steps: [
          { in: { a: true }, expect: { steady: false } }, // t[2]'s edge scan
          { expect: { steady: true } }, // 100 ms held
          { in: { a: false }, expect: { steady: false } },
        ],
        oracle: { skip: FB_ARRAY_UNCHECKABLE },
      },
      {
        // one instance, shared: the program calls it and a block reads the same one back
        name: 'a function-block instance in VAR_GLOBAL is one instance every POU shares',
        src: `VAR_GLOBAL gap : TON; END_VAR
FUNCTION_BLOCK Watch VAR_OUTPUT open : BOOL; END_VAR open := gap.Q; END_FUNCTION_BLOCK
VAR_INPUT go : BOOL; END_VAR
VAR_OUTPUT q : BOOL; fromFb : BOOL; END_VAR
VAR w : Watch; END_VAR
gap(IN := go, PT := T#0.2s);
w();
q := gap.Q; fromFb := w.open;`,
        steps: [
          { in: { go: true }, expect: { q: false, fromFb: false } },
          { expect: { q: false, fromFb: false } },
          { expect: { q: true, fromFb: true } },
        ],
        oracle: { skip: 'strict IEC makes a POU declare VAR_EXTERNAL to reach a VAR_GLOBAL; here every POU sees globals directly, so MATIEC rejects the block that reads gap without one. The same documented permissiveness as the VAR_GLOBAL case above, not a semantic difference' },
      },
      {
        name: 'assigning one timer in an array to another is rejected',
        src: 'VAR d : ARRAY [1..2] OF TON; END_VAR\nd[1] := d[2];',
        steps: [],
        rejects: /cannot assign to function block/,
        oracle: { skip: FB_ARRAY_REJECT_UNCHECKABLE },
      },
      {
        name: 'writing a timer output through an array element is rejected',
        src: 'VAR d : ARRAY [1..2] OF TON; END_VAR\nd[1].Q := TRUE;',
        steps: [],
        rejects: /cannot assign to function-block output 'Q'/,
        oracle: { skip: FB_ARRAY_REJECT_UNCHECKABLE },
      },
      {
        // a FUNCTION starts from nothing on every call, so it cannot hold state however deep
        name: 'a FUNCTION cannot hold function-block instances inside an array',
        src: `FUNCTION F : BOOL
VAR_INPUT go : BOOL; END_VAR
VAR ts : ARRAY [1..2] OF TON; END_VAR
ts[1](IN := go, PT := T#1s);
F := ts[1].Q;
END_FUNCTION
VAR q : BOOL; END_VAR
q := F(TRUE);`,
        steps: [],
        rejects: /a function cannot contain function-block instances/,
        oracle: { skip: FB_ARRAY_REJECT_UNCHECKABLE },
      },
    ],
  },
  {
    // A whole array or struct is a value: it assigns, passes into a FUNCTION or a block's input,
    // comes back out of a block's output, and is what a FUNCTION can return. Each of those is a
    // copy made into the destination's own storage. That lets a tracking array move a package
    // record from zone to zone without every zone holding one shared record.
    title: 'arrays and structs are values, copied whole',
    cases: [
      {
        // An index outside its declared range faults here, naming the index and the range, in both
        // backends: the interpreter in evalExpr/assignPlace, the emitted module through
        // elemAt/elemSet. MATIEC does not check: it emits C, which reads past the array. A simulator
        // that returned the neighbouring bytes would hide the bug where it is cheapest to find, and
        // it would show up on the real line instead.
        //
        // The write half has no case here. An out-of-range store is undefined behaviour in C, so
        // an external compiler would corrupt its own harness. It is tested on the helpers directly,
        // in builtins.test.ts.
        name: 'an array index outside its bounds faults',
        src: `VAR a : ARRAY [0..3] OF INT := [10, 11, 12, 13]; i : INT := 9; v : INT; END_VAR
v := a[i];`,
        steps: [{ throws: /array index 9 out of bounds/ }], // the range is in the message too; the brackets just cost an escape
        divergence:
          'This engine faults on an array subscript outside its declared range. IEC requires a subscript to be within range but says nothing about what a runtime does when it is not, so faulting is a choice: this engine is where the mistake is cheapest to find. MATIEC does not check: it emits C, which reads past the array and completes the scan, so the replay reports "expected 0 scan lines, got 1" for this case.',
      },
      {
        name: 'assigning a struct copies it, field by field',
        src: `TYPE Pkg : STRUCT id : DINT; dest : INT; END_STRUCT; END_TYPE
VAR a : Pkg; b : Pkg; END_VAR
VAR_OUTPUT bid : DINT; bdest : INT; aid : DINT; END_VAR
a.id := 7; a.dest := 3;
b := a;
a.id := 8;
bid := b.id; bdest := b.dest; aid := a.id;`,
        steps: [{ expect: { bid: 7, bdest: 3, aid: 8 } }], // b kept its copy; the later write to a does not reach it
      },
      {
        // the tracking shift: each record is copied into the next slot's own storage, so no two
        // slots end up sharing a record
        name: 'a tracking array shifts whole struct records zone to zone',
        src: `TYPE Pkg : STRUCT id : DINT; dest : INT; END_STRUCT; END_TYPE
VAR_INPUT arriving : DINT; END_VAR
VAR_OUTPUT at1 : DINT; at3 : DINT; END_VAR
VAR track : ARRAY [0..3] OF Pkg; i : INT; END_VAR
FOR i := 3 TO 1 BY -1 DO track[i] := track[i - 1]; END_FOR;
track[0].id := arriving;
at1 := track[1].id; at3 := track[3].id;`,
        steps: [
          { in: { arriving: 11 }, expect: { at1: 0, at3: 0 } },
          { in: { arriving: 12 }, expect: { at1: 11, at3: 0 } },
          { in: { arriving: 13 }, expect: { at1: 12, at3: 0 } },
          { in: { arriving: 14 }, expect: { at1: 13, at3: 11 } }, // the first package reaches the last zone
        ],
      },
      {
        name: 'assigning an array copies every element',
        src: `VAR a : ARRAY [1..3] OF INT := [1, 2, 3]; b : ARRAY [1..3] OF INT; END_VAR
VAR_OUTPUT b2 : INT; a2 : INT; END_VAR
b := a;
a[2] := 20;
b2 := b[2]; a2 := a[2];`,
        steps: [
          { expect: { b2: 2, a2: 20 } }, // copied before the write
          { expect: { b2: 20, a2: 20 } }, // and copied again, write included, on the next scan
        ],
        oracle: { editionReject: 'MATIEC gives every anonymous ARRAY declaration a type of its own, so two arrays declared identically still do not assign ("Incompatible data types for \':=\' operation"). STruC++ (3rd edition) builds it. A named array type would satisfy MATIEC, but this subset has no TYPE ... : ARRAY declarations yet.' },
      },
      {
        // a struct input is taken by value, and a struct output is read back through the instance
        name: 'a function block takes a struct by value and hands one back through its output',
        src: `TYPE Pkg : STRUCT id : DINT; dest : INT; END_STRUCT; END_TYPE
FUNCTION_BLOCK Latch
VAR_INPUT p : Pkg; take : BOOL; END_VAR
VAR_OUTPUT held : Pkg; END_VAR
IF take THEN held := p; END_IF;
END_FUNCTION_BLOCK
VAR l : Latch; box : Pkg; END_VAR
VAR_OUTPUT heldId : DINT; boxId : DINT; END_VAR
box.id := box.id + 1;
l(p := box, take := box.id = 1);
heldId := l.held.id; boxId := box.id;`,
        steps: [
          { expect: { heldId: 1, boxId: 1 } }, // latched the first package
          { expect: { heldId: 1, boxId: 2 } }, // the caller moved on; the block kept its own copy
        ],
      },
      {
        // the output is `data`, not `pkg`: MATIEC refused `VAR_OUTPUT pkg : Pkg` outright ("unknown
        // error in output variable(s) declaration"), a variable spelled like its own type
        name: 'an output binding copies a whole struct out of the block',
        src: `TYPE Pkg : STRUCT id : DINT; dest : INT; END_STRUCT; END_TYPE
FUNCTION_BLOCK Reader
VAR_INPUT raw : DINT; END_VAR
VAR_OUTPUT data : Pkg; END_VAR
data.id := raw; data.dest := 4;
END_FUNCTION_BLOCK
VAR r : Reader; got : Pkg; END_VAR
VAR_OUTPUT gotId : DINT; gotDest : INT; END_VAR
r(raw := 42, data => got);
gotId := got.id; gotDest := got.dest;`,
        steps: [{ expect: { gotId: 42, gotDest: 4 } }],
      },
      {
        name: 'a FUNCTION returns a whole struct, and takes one by value',
        src: `TYPE Pkg : STRUCT id : DINT; dest : INT; END_STRUCT; END_TYPE
FUNCTION MakePkg : Pkg
VAR_INPUT id : DINT; dest : INT; END_VAR
MakePkg.id := id;
MakePkg.dest := dest;
END_FUNCTION
FUNCTION DestOf : INT
VAR_INPUT p : Pkg; END_VAR
DestOf := p.dest;
END_FUNCTION
VAR box : Pkg; END_VAR
VAR_OUTPUT boxId : DINT; boxDest : INT; END_VAR
box := MakePkg(5, 2);
boxId := box.id;
boxDest := DestOf(box);`,
        steps: [{ expect: { boxId: 5, boxDest: 2 } }],
      },
      {
        // an array's [...] starting value outside a PROGRAM: a block's array keeps what the block writes into it, a
        // FUNCTION's local array starts over on every call (its variables are temporary), so both read the list
        name: "an array's starting value holds in a function block and in a FUNCTION",
        src: `FUNCTION_BLOCK Shelf
VAR slots : ARRAY [1..3] OF INT := [4, 5, 6]; END_VAR
VAR_OUTPUT second : INT; END_VAR
second := slots[2];
slots[2] := slots[2] + 10;
END_FUNCTION_BLOCK
FUNCTION Pick : INT
VAR_INPUT i : INT; END_VAR
VAR table : ARRAY [1..3] OF INT := [7, 8, 9]; END_VAR
Pick := table[i];
table[i] := 0;
END_FUNCTION
VAR shelf1 : Shelf; END_VAR
VAR_OUTPUT fromBlock : INT; fromFunction : INT; END_VAR
shelf1();
fromBlock := shelf1.second;
fromFunction := Pick(2);`,
        steps: [{ expect: { fromBlock: 5, fromFunction: 8 } }, { expect: { fromBlock: 15, fromFunction: 8 } }],
      },
      {
        // the same question for a CONSTANT defined from another, inside a block rather than a PROGRAM
        name: 'a CONSTANT defined from another holds inside a function block',
        src: `FUNCTION_BLOCK Lanes
VAR CONSTANT ZONES : INT := 4; LAST : INT := ZONES - 1; END_VAR
VAR_OUTPUT top : INT; END_VAR
top := LAST;
END_FUNCTION_BLOCK
VAR z : Lanes; END_VAR
VAR_OUTPUT lastIndex : INT; END_VAR
z();
lastIndex := z.top;`,
        steps: [{ expect: { lastIndex: 3 } }],
        oracle: { editionReject: 'MATIEC takes only a literal as an initial value, as for the PROGRAM case above ("invalid initial value in specification with initialization"). STruC++ (3rd edition) builds it.' },
      },
      {
        // a whole array goes into a function by value, the way a struct does
        name: 'a FUNCTION takes a whole array by value',
        src: `FUNCTION Total : INT
VAR_INPUT p : ARRAY [1..2] OF INT; END_VAR
Total := p[1] + p[2];
END_FUNCTION
VAR row : ARRAY [1..2] OF INT := [3, 30]; END_VAR
VAR_OUTPUT sum : INT; END_VAR
sum := Total(row);`,
        steps: [{ expect: { sum: 33 } }],
        oracle: { editionReject: 'the same rule as a whole-array assignment: MATIEC gives every anonymous ARRAY declaration a type of its own, so the argument does not match the input ("Data type incompatibility for value passed in position 1 when invoking function \'Total\'"). STruC++ (3rd edition) builds it.' },
      },
      {
        // but a result type has to be a type name: both external compilers refuse an ARRAY spelled
        // out in its place (measured), and this subset cannot name an array type yet
        name: 'an ARRAY written out as a FUNCTION result type is rejected',
        src: `FUNCTION Pair : ARRAY [1..2] OF INT
VAR_INPUT a : INT; END_VAR
Pair[1] := a;
END_FUNCTION
VAR r : INT; END_VAR
r := 1;`,
        steps: [],
        rejects: /a FUNCTION result must be a type name/,
      },
      {
        // no structural typing: two structs with the same fields are still two types
        name: 'a struct of another type is rejected, even with identical fields',
        src: `TYPE A : STRUCT x : INT; END_STRUCT; END_TYPE
TYPE B : STRUCT x : INT; END_STRUCT; END_TYPE
VAR a : A; b : B; END_VAR
a := b;`,
        steps: [],
        rejects: /cannot assign B to 'a' of type A/,
      },
      {
        name: 'an array with different bounds is rejected',
        src: `VAR a : ARRAY [1..3] OF INT; b : ARRAY [0..2] OF INT; END_VAR
a := b;`,
        steps: [],
        rejects: /cannot assign ARRAY\[0\.\.2\] OF INT to 'a' of type ARRAY\[1\.\.3\] OF INT/,
      },
      {
        // an output is the block's own to write, all the way down its fields
        name: 'writing into a field of a function-block output is rejected',
        src: `TYPE Pkg : STRUCT id : DINT; END_STRUCT; END_TYPE
FUNCTION_BLOCK Reader VAR_OUTPUT data : Pkg; END_VAR data.id := 1; END_FUNCTION_BLOCK
VAR r : Reader; END_VAR
r();
r.data.id := 5;`,
        steps: [],
        rejects: /cannot assign to function-block output 'data'/,
      },
    ],
  },
  {
    // Three spellings real IEC code uses: `**`, an
    // enumeration value written with its type (`Mode#Idle`), and a formal FUNCTION call that names
    // its arguments. None adds a meaning; each only lets existing meaning be written the standard way.
    title: 'IEC spellings: **, Type#Member, formal function calls',
    cases: [
      {
        // `**` is EXPT, and the standard's grammar puts it above `*` and below a unary sign, left
        // to right: power_expression ::= unary_expression {'**' unary_expression}. The operator
        // table in the same standard reads as if negation came after exponentiation, so the
        // grammar is taken here and the oracle is what says whether a real compiler agrees.
        name: '** is EXPT: tighter than *, looser than a unary sign, left to right',
        src: `VAR_OUTPUT sq : REAL; scaled : REAL; neg : REAL; chained : REAL; END_VAR
sq := 3.0 ** 2.0;
scaled := 2.0 ** 3.0 * 2.0;
neg := -2.0 ** 2.0;
chained := 2.0 ** 3.0 ** 2.0;`,
        steps: [{ close: { sq: 9, scaled: 16, neg: 4, chained: 64 } }],
      },
      {
        // the qualified spelling in every place a member can appear: an initial value, a store, a
        // CASE label and a comparison. The initial value is the one place in this corpus where an
        // enumeration starts somewhere other than its first member, so it checks that both backends
        // keep a declared starting value.
        name: 'Mode#Member names an enumeration value wherever a member can go',
        src: `TYPE Mode : (Idle, Running, Faulted); END_TYPE
VAR_INPUT go : BOOL; END_VAR
VAR m : Mode := Mode#Faulted; END_VAR
VAR_OUTPUT code : INT; isRun : BOOL; END_VAR
IF go THEN m := Mode#Running; END_IF;
CASE m OF
  Mode#Idle: code := 0;
  Mode#Running: code := 1;
  Mode#Faulted: code := 2;
END_CASE;
isRun := m = Mode#Running;`,
        steps: [
          { expect: { code: 2, isRun: false } }, // started where it was declared to
          { in: { go: true }, expect: { code: 1, isRun: true } },
        ],
      },
      {
        name: 'a formal FUNCTION call names its arguments in any order',
        src: `FUNCTION Clamp : INT
VAR_INPUT v : INT; lo : INT; hi : INT; END_VAR
IF v < lo THEN Clamp := lo; ELSIF v > hi THEN Clamp := hi; ELSE Clamp := v; END_IF;
END_FUNCTION
VAR_INPUT raw : INT; END_VAR
VAR_OUTPUT named : INT; ordered : INT; END_VAR
named := Clamp(hi := 100, v := raw, lo := 0);
ordered := Clamp(raw, 0, 100);`,
        steps: [
          { in: { raw: 150 }, expect: { named: 100, ordered: 100 } },
          { in: { raw: -5 }, expect: { named: 0, ordered: 0 } },
          { in: { raw: 42 }, expect: { named: 42, ordered: 42 } },
        ],
      },
      {
        // IEC: a formal call may leave an input out, and the input then takes its declared initial
        // value - here `gain` starts at 2 and `offset` at 10. The function is called fresh each time,
        // so what one call gave an input never carries into the next call that omits it.
        name: 'an input a formal FUNCTION call leaves out takes its initial value',
        src: `FUNCTION Scale : INT
VAR_INPUT v : INT; gain : INT := 2; offset : INT := 10; END_VAR
Scale := v * gain + offset;
END_FUNCTION
VAR_OUTPUT a : INT; b : INT; c : INT; e : INT; END_VAR
a := Scale(v := 5);
b := Scale(v := 5, offset := 0);
c := Scale(offset := 1, v := 3, gain := 3);
e := Scale(v := 5);`,
        steps: [{ expect: { a: 20, b: 10, c: 10, e: 20 } }],
      },
      {
        // an input that declares no initial value starts at its type's, as any variable does
        name: 'an input with no initial value that a call leaves out starts at zero',
        src: `FUNCTION Scale : INT
VAR_INPUT v : INT; gain : INT := 2; offset : INT := 10; END_VAR
Scale := v * gain + offset;
END_FUNCTION
VAR_OUTPUT d : INT; END_VAR
d := Scale(gain := 4);`,
        steps: [{ expect: { d: 10 } }],
      },
      {
        // IEC 61131-3's own parameter names, which MATIEC (the oracle) accepts too: IN / IN1..INn, LIMIT's MN IN MX,
        // SEL's G IN0 IN1, MUX's K IN0.., MID's IN L P. Named, the arguments go in any order
        name: 'a standard function called formally takes its arguments by IEC name',
        src: `VAR_INPUT raw : INT; END_VAR
VAR s : STRING := 'conveyor'; END_VAR
VAR_OUTPUT a : INT; b : INT; c : STRING; d : BOOL; e : INT; f : INT; END_VAR
a := LIMIT(IN := raw, MX := 100, MN := 0);
b := MUX(IN1 := 20, K := 1, IN0 := 10);
c := MID(P := 2, IN := s, L := 3);
d := GT(IN2 := 3, IN1 := 5);
e := SEL(IN1 := 7, G := raw > 0, IN0 := 3);
f := ADD(IN3 := 3, IN1 := 1, IN2 := 2);`,
        steps: [
          { in: { raw: 150 }, expect: { a: 100, b: 20, c: 'onv', d: true, e: 7, f: 6 } },
          { in: { raw: -5 }, expect: { a: 0, e: 3 } },
        ],
      },
      {
        name: 'a formal call of a standard function that leaves an input out is rejected',
        src: 'VAR x : INT; n : INT; END_VAR\nn := LIMIT(IN := x, MX := 9);',
        steps: [],
        rejects: /'LIMIT' input 'MN' is not given/,
        oracle: {
          skip: "MATIEC builds it, leaving MN at its type's zero, as a user FUNCTION's omitted input is left at its start value. This engine asks for every input of a STANDARD function: which type that zero has is overload resolution's to say (LIMIT is generic), and a program that means 0 can write it. A limit of this subset, stricter than the standard, so it is withheld rather than claimed",
        },
      },
      {
        name: 'a formal call naming an input the function does not have is rejected',
        src: `FUNCTION Clamp : INT
VAR_INPUT v : INT; lo : INT; hi : INT; END_VAR
Clamp := v;
END_FUNCTION
VAR n : INT; END_VAR
n := Clamp(v := 1, lo := 0, top := 2);`,
        steps: [],
        rejects: /'Clamp' has no input 'top'/,
      },
      {
        name: 'a qualified value that is not a member of its enumeration is rejected',
        src: `TYPE Mode : (Idle, Running); END_TYPE
TYPE Door : (Open, Shut); END_TYPE
VAR m : Mode; END_VAR
m := Mode#Open;`,
        steps: [],
        rejects: /'Open' is not a member of enumeration Mode/,
      },
      {
        name: "an enumeration starting at another enumeration's member is rejected",
        src: `TYPE Mode : (Idle, Running); END_TYPE
TYPE Door : (Open, Shut); END_TYPE
VAR m : Mode := Open; END_VAR
m := Idle;`,
        steps: [],
        rejects: /cannot initialise 'm' of type enumeration Mode with enumeration Door/,
      },
    ],
  },
  {
    // A type given a name of its own. A named array type is one type under its name, which is how
    // MATIEC types arrays: it refuses copying between two arrays spelled out in place (see the
    // whole-values group above) and requires a named type instead. A plain alias names its base.
    title: 'named types: TYPE Name : ARRAY and plain aliases',
    cases: [
      {
        // A subrange place holds its declared bounds at run time, in both backends: the interpreter
        // in checkRange, the emitted module through inRange, both applied after the width coercion
        // and before the store, which is the one call site there is. Without this case the two
        // backends could disagree about subranges unnoticed.
        name: 'a store outside a subrange faults',
        src: `TYPE Percent : INT (0..100); END_TYPE
VAR n : INT := 250; level : Percent; END_VAR
level := n;`,
        steps: [{ throws: /250 is outside Percent/ }],
        divergence:
          'This engine faults on a store outside a subrange. IEC declares the range but leaves the runtime free, so faulting is this engine being the place the mistake is cheapest to find, exactly as with an array bound. MATIEC does not check and completes the scan, which is why the replay reports "expected 0 scan lines, got 1" here.',
      },
      {
        // two variables of one named array type copy into each other, which MATIEC takes; it
        // refuses the very same copy between two arrays spelled out in place
        name: 'a named array type copies whole and starts from a [...] list',
        src: `TYPE Row : ARRAY [1..3] OF INT; END_TYPE
VAR a : Row := [1, 2, 3]; b : Row; END_VAR
VAR_OUTPUT b2 : INT; a2 : INT; END_VAR
b := a;
a[2] := 20;
b2 := b[2]; a2 := a[2];`,
        steps: [
          { expect: { b2: 2, a2: 20 } }, // copied before the write
          { expect: { b2: 20, a2: 20 } }, // and copied again, write included, on the next scan
        ],
      },
      {
        name: 'a named array type passes into a FUNCTION by value and is its result',
        src: `TYPE Row : ARRAY [1..3] OF INT; END_TYPE
FUNCTION Doubled : Row
VAR_INPUT r : Row; END_VAR
VAR i : INT; END_VAR
FOR i := 1 TO 3 DO Doubled[i] := r[i] * 2; END_FOR;
END_FUNCTION
VAR a : Row := [1, 2, 3]; b : Row; END_VAR
VAR_OUTPUT b2 : INT; a2 : INT; END_VAR
b := Doubled(a);
a[2] := 20;
b2 := b[2]; a2 := a[2];`,
        steps: [
          { expect: { b2: 4, a2: 20 } },
          { expect: { b2: 40, a2: 20 } }, // doubled from a as last scan's write left it
        ],
        oracle: { skip: 'MATIEC compiles this program, which is its verdict that the ST is valid, but the C it generates cannot pass an array into a function or take one back as the result ("aggregate value used where an integer was expected"), so the replay has nothing to run. STruC++ (3rd edition) builds it. The goldens are checked in-process, through both backends' },
      },
      {
        // the addend is `inc`, not `step`: MATIEC reserves STEP, a Sequential Function Chart keyword,
        // in ST too, and refused this case's first spelling for that alone
        name: 'a plain alias names its base type',
        src: `TYPE Count : INT; END_TYPE
VAR n : Count := 3; inc : INT := 4; END_VAR
VAR_OUTPUT total : INT; END_VAR
n := n + inc;
total := n;`,
        steps: [{ expect: { total: 7 } }, { expect: { total: 11 } }],
      },
      {
        name: 'arrays of two names are two types, however alike',
        src: `TYPE RowA : ARRAY [1..3] OF INT; END_TYPE
TYPE RowB : ARRAY [1..3] OF INT; END_TYPE
VAR a : RowA; b : RowB; END_VAR
a := b;`,
        steps: [],
        rejects: /cannot assign RowB to 'a' of type RowA/,
      },
      {
        name: 'a named array and an array spelled out in place are two types',
        src: `TYPE Row : ARRAY [1..3] OF INT; END_TYPE
VAR a : Row; b : ARRAY [1..3] OF INT; END_VAR
a := b;`,
        steps: [],
        rejects: /cannot assign ARRAY\[1\.\.3\] OF INT to 'a' of type Row/,
      },
      {
        // a bound written as a CONSTANT, and as an expression over one, so a zone count lives in
        // one place instead of being repeated in every array sized by it
        name: 'an array bound can be a named CONSTANT or an expression over one',
        src: `VAR CONSTANT ZONES : INT := 4; LAST : INT := 3; END_VAR
VAR eyes : ARRAY [0..LAST] OF BOOL; tally : ARRAY [1..ZONES * 2] OF INT; i : INT; END_VAR
VAR_OUTPUT seen : INT; top : INT; END_VAR
seen := 0;
FOR i := 0 TO LAST DO eyes[i] := TRUE; seen := seen + 1; END_FOR;
tally[ZONES * 2] := seen;
top := tally[8];`,
        steps: [{ expect: { seen: 4, top: 4 } }],
        oracle: { editionReject: 'MATIEC calls a named CONSTANT in array bounds non-standard for IEC 61131-3 ("Use of variables in array size limits is not allowed in IEC 61131-3 (use -a option to activate support for this non-standard feature)"). STruC++ (3rd edition) builds it.' },
      },
      {
        // one CONSTANT defined from another, so the last zone's index follows the zone count. Split
        // from the case above after MATIEC refused this line alone
        name: 'a CONSTANT can be defined from another CONSTANT',
        src: `VAR CONSTANT ZONES : INT := 4; LAST : INT := ZONES - 1; END_VAR
VAR_OUTPUT lastIndex : INT; END_VAR
lastIndex := LAST;`,
        steps: [{ expect: { lastIndex: 3 } }],
        oracle: { editionReject: 'MATIEC takes only a literal as an initial value, so a CONSTANT defined from another is "invalid initial value in specification with initialization". STruC++ (3rd edition) builds it.' },
      },
    ],
  },
  {
    // A struct's starting value names its fields, `(id := 7, dest := 3)`, leaving any field it does
    // not name at zero, nesting as deep as the type goes; a list of them starts an array of structs.
    // (Once only a scalar, or an array of scalars, could start anywhere but zero.)
    title: 'structured initial values: (field := value) and arrays of them',
    cases: [
      {
        // the outputs are not `pid` and friends: MATIEC ships a PID function block in its library,
        // and this case's first spelling did not get past declaring `pid` there
        name: 'a struct starts from its named fields, the rest at zero',
        src: `TYPE Pkg : STRUCT id : DINT; dest : INT; fragile : BOOL; END_STRUCT; END_TYPE
VAR p : Pkg := (id := 7, dest := 3); END_VAR
VAR_OUTPUT boxId : DINT; boxDest : INT; boxFragile : BOOL; END_VAR
boxId := p.id; boxDest := p.dest; boxFragile := p.fragile;`,
        steps: [{ expect: { boxId: 7, boxDest: 3, boxFragile: false } }],
      },
      {
        name: 'an array of structs starts from a list of field lists',
        src: `TYPE Pkg : STRUCT id : DINT; dest : INT; fragile : BOOL; END_STRUCT; END_TYPE
VAR lane : ARRAY [1..2] OF Pkg := [(id := 1, dest := 4), (id := 2, fragile := TRUE)]; END_VAR
VAR_OUTPUT firstDest : INT; secondId : DINT; secondDest : INT; secondFragile : BOOL; END_VAR
firstDest := lane[1].dest; secondId := lane[2].id; secondDest := lane[2].dest; secondFragile := lane[2].fragile;`,
        steps: [{ expect: { firstDest: 4, secondId: 2, secondDest: 0, secondFragile: true } }],
        oracle: { skip: STRUCTURED_LIST_UNCHECKABLE },
      },
      {
        name: 'a structured initial value nests a struct inside a struct',
        src: `TYPE Pt : STRUCT x : INT; y : INT; END_STRUCT; END_TYPE
TYPE Zone : STRUCT origin : Pt; width : INT; END_STRUCT; END_TYPE
VAR z : Zone := (origin := (x := 5, y := 6), width := 3); END_VAR
VAR_OUTPUT oy : INT; w : INT; END_VAR
oy := z.origin.y; w := z.width;`,
        steps: [{ expect: { oy: 6, w: 3 } }],
      },
      {
        name: "an array field starts from a [...] list inside a struct's initializer",
        src: `TYPE Zone : STRUCT eyes : ARRAY [1..3] OF BOOL; END_STRUCT; END_TYPE
VAR z : Zone := (eyes := [FALSE, TRUE, FALSE]); END_VAR
VAR_OUTPUT eye2 : BOOL; eye3 : BOOL; END_VAR
eye2 := z.eyes[2]; eye3 := z.eyes[3];`,
        steps: [{ expect: { eye2: true, eye3: false } }],
        oracle: { skip: STRUCTURED_LIST_UNCHECKABLE },
      },
      {
        name: 'naming a field the struct does not have is rejected',
        src: `TYPE Pkg : STRUCT id : DINT; dest : INT; END_STRUCT; END_TYPE
VAR p : Pkg := (id := 1, weight := 2); END_VAR
p.id := 2;`,
        steps: [],
        rejects: /'Pkg' has no field 'weight'/,
      },
      {
        name: 'a field value of the wrong type is rejected',
        src: `TYPE Pkg : STRUCT id : DINT; dest : INT; END_STRUCT; END_TYPE
VAR p : Pkg := (id := TRUE); END_VAR
p.id := 2;`,
        steps: [],
        rejects: /cannot assign BOOL to 'p' field 'id' of type DINT/,
      },
    ],
  },
  {
    // The engine parses a whole file at once and does not care what order the definitions came
    // in. The exporter does, in two passes, neither of which is the parser. exportText.ts splits
    // the POUs off the front of raw source with a keyword scan, and export.ts then pairs the split
    // text with the parsed AST by position (`ast.fbDefs[i]` with `fbTexts[i]`), falling back to
    // an empty body when the two disagree. So a file grouped FB-FB-FUNCTION cannot exercise what
    // a file ordered FB-FUNCTION-FB does. A wrong pairing does not throw: it emits a POU with the
    // right name, the right interface and no code, which opens on a target and silently does
    // nothing. Every case below is ordinary ST that a real project would contain. They exist
    // because the rest of the corpus puts definitions first, grouped by kind.
    //
    // `(* *)` comments only. `//` is a 3rd-edition spelling and these have to build under the
    // 2nd-edition oracle too.
    title: 'file structure - POUs in any order, not just grouped by kind',
    cases: [
      {
        // A FUNCTION between two FUNCTION_BLOCKs: the interleaving the positional pairing is
        // most exposed to, since it filters by kind and then trusts index order to line up.
        // Everything is declared before it is used, so this is valid without forward
        // references. The order is the whole subject.
        //
        // Two names here are chosen to pass MATIEC, both measured in CI, because
        // a case about order must not fail over a name:
        //   - the input is `inc`, not `step` - STEP is an SFC keyword to a 2nd-edition compiler,
        //     so it cannot sit in identifier position; our engine has no SFC and takes it. The
        //     same spelling in the VAR_GLOBAL case below is invisible only because that case is
        //     withheld from the oracle.
        //   - the output is `halved`, not `half` - IEC identifiers are case-insensitive and the
        //     whole file shares one namespace, so a variable named `half` collides with
        //     `FUNCTION Half`; our engine keeps POU and variable names apart and takes it.
        name: 'a FUNCTION declared between two FUNCTION_BLOCKs',
        src: `FUNCTION_BLOCK Accum
VAR_INPUT inc : INT; END_VAR
VAR_OUTPUT total : INT; END_VAR
total := total + inc;
END_FUNCTION_BLOCK
FUNCTION Half : INT
VAR_INPUT v : INT; END_VAR
Half := v / 2;
END_FUNCTION
FUNCTION_BLOCK Damped
VAR_INPUT raw : INT; END_VAR
VAR_OUTPUT out : INT; END_VAR
out := Half(raw);
END_FUNCTION_BLOCK
VAR a : Accum; d : Damped; END_VAR
VAR_OUTPUT sum : INT; halved : INT; END_VAR
a(inc := 7);
d(raw := 9);
sum := a.total;
halved := d.out;`,
        // the block accumulates (instance state), the function does not (9/2 truncates toward
        // zero to 4 on every scan, IEC integer division)
        steps: [
          { expect: { sum: 7, halved: 4 } },
          { expect: { sum: 14, halved: 4 } },
          { expect: { sum: 21, halved: 4 } },
        ],
      },
      {
        // A TYPE that is not at the top of the file. The peeler accepts TYPE / VAR_GLOBAL /
        // FUNCTION_BLOCK / FUNCTION in any order at the front, so a struct declared between
        // two blocks is legal here and on a target; nothing in the corpus said so.
        name: 'a TYPE declared between two FUNCTION_BLOCKs',
        src: `FUNCTION_BLOCK Latch
VAR_INPUT s : BOOL; END_VAR
VAR_OUTPUT q : BOOL; END_VAR
IF s THEN q := TRUE; END_IF;
END_FUNCTION_BLOCK
TYPE Span : STRUCT lo : INT; hi : INT; END_STRUCT; END_TYPE
FUNCTION_BLOCK Window
VAR_INPUT v : INT; END_VAR
VAR_OUTPUT inside : BOOL; END_VAR
VAR range : Span; END_VAR
range.lo := 10; range.hi := 20;
inside := (v >= range.lo) AND (v <= range.hi);
END_FUNCTION_BLOCK
VAR l : Latch; w : Window; END_VAR
VAR_INPUT n : INT; END_VAR
VAR_OUTPUT held : BOOL; ok : BOOL; END_VAR
w(v := n);
l(s := w.inside);
ok := w.inside;
held := l.q;`,
        // the window is combinational, the latch retains: once inside, held stays set after
        // the value leaves the span
        steps: [
          { in: { n: 15 }, expect: { ok: true, held: true } },
          { in: { n: 5 }, expect: { ok: false, held: true } },
        ],
      },
      {
        // Comments between blocks, which is a different slice than a comment above the first
        // one (the earlier case). The splitter cuts from the end of the previous block, so a
        // note between two POUs goes with the one that follows it. If that slice were taken
        // from the keyword instead, the comment would end up in the wrong POU, or, if it names
        // a terminator, end a block early.
        name: 'comments between POUs travel with the block below them',
        src: `(* --- motion helpers --- *)
FUNCTION_BLOCK Up
VAR_OUTPUT n : INT; END_VAR
n := n + 1;
END_FUNCTION_BLOCK
(* the block below is separated from the one above by this note alone.
   It even says END_FUNCTION_BLOCK, which must not close anything. *)
FUNCTION_BLOCK Down
VAR_OUTPUT n : INT; END_VAR
n := n - 1;
END_FUNCTION_BLOCK
(* and the program body follows *)
VAR u : Up; d : Down; END_VAR
VAR_OUTPUT hi : INT; lo : INT; END_VAR
u(); d();
hi := u.n; lo := d.n;`,
        steps: [
          { expect: { hi: 1, lo: -1 } },
          { expect: { hi: 2, lo: -2 } },
        ],
      },
    ],
  },
  {
    title: 'STRING is character data, ordered but not arithmetic',
    // Unsized `STRING` throughout, except where the capacity is the subject: MATIEC cannot
    // compile a sized string variable in any spelling (the truncation case below carries the
    // full diagnosis), so declaring a capacity a case never relies on would withhold it from
    // the external oracle for nothing. Unsized is IEC's 80-character default and resolves as
    // an ordinary elementary type everywhere.
    cases: [
      {
        // the whole point of the 1-based convention: LEFT/RIGHT count characters, MID and
        // FIND count positions, and MID's argument order is (IN, L, P) - length before
        // position, which is the trap for anyone arriving from a 0-based language
        name: 'the string library indexes from 1, and MID takes (IN, L, P)',
        src: `VAR s : STRING := 'Conveyor'; END_VAR
VAR_OUTPUT n : INT; l : STRING; r : STRING; m : STRING; f : INT; g : INT; END_VAR
n := LEN(s); l := LEFT(s, 3); r := RIGHT(s, 3); m := MID(s, 2, 4);
f := FIND(s, 'vey'); g := FIND(s, 'zz');`,
        steps: [{ expect: { n: 8, l: 'Con', r: 'yor', m: 've', f: 4, g: 0 } }],
      },
      {
        // IEC has no `+` for strings, so joining is CONCAT and the edit trio works on
        // (length, position) pairs the same way MID does
        name: 'CONCAT joins; INSERT/DELETE/REPLACE edit at a position',
        src: `VAR_OUTPUT c : STRING; i : STRING; d : STRING; p : STRING; END_VAR
c := CONCAT('LINE', '-01');
i := INSERT('ABEF', 'CD', 2);
d := DELETE('ABCDEF', 2, 3);
p := REPLACE('ABCDEF', 'xy', 2, 3);`,
        steps: [{ expect: { c: 'LINE-01', i: 'ABCDEF', d: 'ABEF', p: 'ABxyEF' } }],
      },
      {
        // a store into a shorter STRING truncates rather than faulting - MATIEC cuts
        // silently, and a program that relies on the cut must behave the same here or
        // the simulator flatters it
        name: 'a store truncates to the declared capacity',
        src: `VAR short : STRING[3]; END_VAR VAR_OUTPUT out : STRING[8]; n : INT; END_VAR
short := 'abcdef'; out := short; n := LEN(short);`,
        steps: [{ expect: { out: 'abc', n: 3 } }],
        oracle: {
          skip: 'NEITHER external compiler can take a sized STRING variable, in either spelling, so there is no toolchain to check the capacity against. MATIEC parses `VAR s : STRING[3];` and registers the variable (its grammar has IEC\'s own single_byte_string_var_declaration), but search_base_type.cc has no visitor for single_byte_string_spec_c, so the datatype never resolves and every USE reports "Variable not declared in this scope". Hoisting it to `TYPE Str3 : STRING[3]; END_TYPE` + `VAR s : Str3;` is worse, not better: simple_specification accepts only elementary and simple type names, while a string type name is registered under a different token class, so that form is a syntax error ("invalid specification in variable declaration"). STruC++ 0.6.2 rejects both spellings outright. The capacity semantics are covered by plc.test.ts instead.',
        },
      },
      {
        // ordering is by character code, so upper case sorts before lower - the same
        // order the standard's comparison functions specify
        //
        // The outputs are not named `lt`, `eq` and `ge`, because MATIEC refuses those as
        // identifiers: its lexer is shared with Instruction List, where LT/GE/EQ (and
        // ADD/SUB/MUL/DIV/GT/LE/NE) are operators, so they are keywords everywhere. This
        // engine allows them, which is a portability trap of its own, recorded under
        // "Known permissiveness" and warned about on export. The case is about comparison
        // semantics, so it uses names every compiler accepts.
        name: 'STRING compares lexicographically by character code',
        src: `VAR a : STRING := 'apple'; b : STRING := 'banana'; c : STRING := 'Apple'; END_VAR
VAR_OUTPUT isLess : BOOL; isSame : BOOL; isAtLeast : BOOL; upperFirst : BOOL; END_VAR
isLess := a < b; isSame := a = 'apple'; isAtLeast := a >= b; upperFirst := c < a;`,
        steps: [{ expect: { isLess: true, isSame: true, isAtLeast: false, upperFirst: true } }],
      },
      {
        name: 'the $ escapes decode to their control characters',
        src: `VAR_OUTPUT q : STRING; d : STRING; n : INT; m : INT; END_VAR
q := 'it$'s'; d := 'a$$b'; n := LEN(q); m := LEN('x$0Dy');`,
        steps: [{ expect: { q: "it's", d: 'a$b', n: 4, m: 3 } }],
      },
      {
        // integer <-> STRING is exact and portable; the REAL and TIME formats are not,
        // which is why only the integer round trip is a golden here
        name: 'INT_TO_STRING and STRING_TO_INT round trip',
        src: `VAR_OUTPUT s : STRING; n : INT; END_VAR
s := INT_TO_STRING(-42); n := STRING_TO_INT('1234');`,
        steps: [{ expect: { s: '-42', n: 1234 } }],
      },
      {
        name: 'MIN and MAX order strings, since IEC makes them generic over ordered values',
        src: `VAR_OUTPUT lo : STRING; hi : STRING; END_VAR
lo := MIN('b', 'a', 'c'); hi := MAX('b', 'a', 'c');`,
        steps: [{ expect: { lo: 'a', hi: 'c' } }],
      },
      {
        // strictness: a real compiler has no `+` for STRING either, so accepting this
        // would build in the simulator and fail on the target
        name: 'rejects + on STRING operands',
        src: `VAR a : STRING := 'x'; b : STRING := 'y'; c : STRING; END_VAR
c := a + b;`,
        steps: [],
        rejects: /\+ is not defined on STRING operands/,
      },
      {
        name: 'rejects an implicit STRING <-> number store in both directions',
        src: `VAR s : STRING; n : INT; END_VAR
n := s;`,
        steps: [],
        rejects: /cannot assign STRING to 'n' of type INT/,
      },
      {
        name: 'rejects a non-STRING argument to the string library',
        src: `VAR n : INT := 5; x : INT; END_VAR
x := LEN(n);`,
        steps: [],
        rejects: /'LEN' needs a STRING argument/,
      },
      {
        name: 'an out-of-range length or position clamps instead of erroring',
        src: `VAR_OUTPUT a : STRING; b : STRING; n : INT; END_VAR
a := LEFT('ab', 99); b := MID('ab', 5, 9); n := LEN(b);`,
        steps: [{ expect: { a: 'ab', b: '', n: 0 } }],
        divergence:
          'IEC calls an out-of-range length/position an error. This engine clamps to the string instead - faulting a scan over a short string is not behaviour a controller survives.',
      },
      {
        name: 'REAL_TO_STRING formatting is implementation-defined',
        src: `VAR_OUTPUT s : STRING; END_VAR
s := REAL_TO_STRING(1.5);`,
        steps: [{ expect: { s: '1.5' } }],
        divergence:
          'IEC leaves float-to-text formatting to the implementation, and the vendors disagree (trailing zeros, exponent thresholds). We emit the shortest round-trip form. The VALUE is portable; the exact spelling is not, so do not parse it on the target.',
        oracle: { skip: 'the expected spelling is ours by definition - MATIEC prints its own float format, so a diff here would report a difference the standard permits rather than a defect' },
      },
      {
        name: 'TIME_TO_STRING emits an IEC duration literal',
        src: `VAR_OUTPUT s : STRING; END_VAR
s := TIME_TO_STRING(T#1s500ms);`,
        steps: [{ expect: { s: 'T#1s500ms' } }],
        divergence:
          'The output is an IEC duration literal (T#1s500ms); IEC does not fix a TIME_TO_STRING format. Chosen so the output round-trips back through STRING_TO_TIME.',
        oracle: { skip: 'same as REAL_TO_STRING - the format is implementation-defined, so a diff against MATIEC would be reporting a permitted difference' },
      },
    ],
  },
  {
    // DATE, TIME_OF_DAY and DATE_AND_TIME. Every golden is milliseconds from the type's origin (1970-01-01 UTC,
    // or midnight), the unit TIME already carries here, computed independently of this engine (Python
    // datetime). MATIEC holds them as seconds + nanoseconds from the same origins, and the harness flattens
    // them to ms exactly as it does TIME (oracleShape.ts `readback`). The typing is IEC's table of time
    // functions as MATIEC enforces it, as measured: a TOD or DT plus or minus a TIME, the difference
    // of two of one kind, and nothing else - no DATE + TIME, no TIME + TOD, no mixed comparison.
    title: 'dates and times of day: DATE, TOD and DT',
    cases: [
      {
        name: 'calendar literals, short and long, are milliseconds from their origin',
        src: `VAR d : DATE := D#2024-02-29; t : TOD := TOD#13:45:30.25; x : DT := DT#2024-02-29-13:45:30;
dl : DATE := DATE#1970-01-02; tl : TIME_OF_DAY := TIME_OF_DAY#0:0:1; xl : DATE_AND_TIME := DATE_AND_TIME#1970-01-01-00:01:00; END_VAR
VAR_OUTPUT od : DATE; ot : TOD; ox : DT; END_VAR
od := d; ot := t; ox := x;`,
        steps: [{ expect: { od: 1709164800000, ot: 49530250, ox: 1709214330000, dl: 86400000, tl: 1000, xl: 60000 } }],
      },
      {
        name: 'the calendar operators: a TOD or DT plus or minus a TIME, and differences',
        src: `VAR d1 : DATE := D#2024-03-01; d0 : DATE := D#2024-02-28; t0 : TOD := TOD#08:00:00; t1 : TOD := TOD#17:30:00;
x0 : DT := DT#2024-02-28-23:00:00; x1 : DT := DT#2024-02-29-01:30:00; dur : TIME := T#1h; END_VAR
VAR_OUTPUT days : TIME; shift : TIME; gap : TIME; later : TOD; earlier : TOD; next : DT; prev : DT; END_VAR
days := d1 - d0; shift := t1 - t0; gap := x1 - x0;
later := t0 + dur; earlier := t1 - dur; next := x0 + dur; prev := x1 - dur;`,
        // 2024 is a leap year, so 28 February to 1 March is two days
        steps: [{ expect: { days: 172800000, shift: 34200000, gap: 9000000, later: 32400000, earlier: 59400000, next: 1709164800000, prev: 1709166600000 } }],
      },
      {
        name: 'the time and date functions compute what their operators do',
        src: `VAR a : TIME := T#1s; b : TIME := T#250ms; d : DATE := D#2024-02-29; t : TOD := TOD#12:00:00; x : DT := DT#2024-02-29-12:00:00; END_VAR
VAR_OUTPUT sum : TIME; diff : TIME; four : TIME; half : TIME; t2 : TOD; t3 : TOD; x2 : DT; x3 : DT;
dd : TIME; tt : TIME; span : TIME; joined : DT; END_VAR
sum := ADD_TIME(a, b); diff := SUB_TIME(a, b); four := MULTIME(b, 4); half := DIVTIME(a, 2);
t2 := ADD_TOD_TIME(t, a); t3 := SUB_TOD_TIME(t, a); x2 := ADD_DT_TIME(x, a); x3 := SUB_DT_TIME(x, a);
dd := SUB_DATE_DATE(d, D#2024-02-28); tt := SUB_TOD_TOD(t, TOD#11:00:00); span := SUB_DT_DT(x, DT#2024-02-28-12:00:00);
joined := CONCAT_DATE_TOD(d, t);`,
        steps: [
          {
            expect: {
              sum: 1250, diff: 750, four: 1000, half: 500,
              t2: 43201000, t3: 43199000, x2: 1709208001000, x3: 1709207999000,
              dd: 86400000, tt: 3600000, span: 86400000, joined: 1709208000000,
            },
          },
        ],
      },
      {
        name: 'MUL_TIME and DIV_TIME, the 3rd edition names for MULTIME and DIVTIME',
        src: `VAR a : TIME := T#1s; END_VAR
VAR_OUTPUT m : TIME; q : TIME; END_VAR
m := MUL_TIME(a, 3); q := DIV_TIME(a, 4);`,
        steps: [{ expect: { m: 3000, q: 250 } }],
        oracle: { editionReject: "MUL_TIME and DIV_TIME are the 3rd edition's names; the 2nd edition, and so MATIEC, calls them MULTIME and DIVTIME (lib/standard_functions.txt), which the case above uses. STruC++ has both spellings." },
      },
      {
        name: 'ADD takes a TIME_OF_DAY the way + does',
        src: `VAR t : TOD := TOD#12:00:00; dur : TIME := T#30m; END_VAR
VAR_OUTPUT later : TOD; END_VAR
later := ADD(t, dur);`,
        steps: [{ expect: { later: 45000000 } }],
      },
      {
        name: 'SUB of two DATEs is a TIME, as - is',
        src: `VAR d1 : DATE := D#2024-03-01; d0 : DATE := D#2024-02-28; END_VAR
VAR_OUTPUT days : TIME; END_VAR
days := SUB(d1, d0);`,
        steps: [{ expect: { days: 172800000 } }],
      },
      {
        name: 'a DT splits into its DATE and its TIME_OF_DAY',
        src: `VAR x : DT := DT#2024-02-29-13:45:30; END_VAR
VAR_OUTPUT d : DATE; t : TOD; d2 : DATE; t2 : TOD; END_VAR
d := DT_TO_DATE(x); t := DT_TO_TOD(x); d2 := DATE_AND_TIME_TO_DATE(x); t2 := DATE_AND_TIME_TO_TIME_OF_DAY(x);`,
        steps: [{ expect: { d: 1709164800000, t: 49530000, d2: 1709164800000, t2: 49530000 } }],
      },
      {
        name: 'calendar values are ordered within their own type',
        src: `VAR a : TOD := TOD#08:00:00; b : TOD := TOD#17:00:00; d : DATE := D#2024-01-01; e : DATE := D#2024-01-01; END_VAR
VAR_OUTPUT before : BOOL; same : BOOL; latest : TOD; clamped : TOD; END_VAR
before := a < b; same := d = e; latest := MAX(a, b); clamped := LIMIT(TOD#09:00:00, a, TOD#12:00:00);`,
        steps: [{ expect: { before: true, same: true, latest: 61200000, clamped: 32400000 } }],
      },
      {
        // whole seconds are spelled the same by MATIEC's library and by this engine, so this case is replayed
        name: 'calendar values print as their literals',
        src: `VAR d : DATE := D#2024-02-29; t : TOD := TOD#07:05:09; x : DT := DT#2024-02-29-07:05:09; END_VAR
VAR_OUTPUT sd : STRING; st : STRING; sx : STRING; END_VAR
sd := DATE_TO_STRING(d); st := TOD_TO_STRING(t); sx := DT_TO_STRING(x);`,
        steps: [{ expect: { sd: 'D#2024-02-29', st: 'TOD#07:05:09', sx: 'DT#2024-02-29-07:05:09' } }],
      },
      {
        name: 'a fraction of a second prints in milliseconds, and a literal in a STRING reads back',
        src: `VAR t : TOD := TOD#07:05:09.5; END_VAR
VAR_OUTPUT st : STRING; d : DATE; x : DT; back : TOD; junk : DATE; END_VAR
st := TOD_TO_STRING(t); d := STRING_TO_DATE('D#2024-02-29'); x := STRING_TO_DT('2024-02-29-00:00:01');
back := STRING_TO_TOD(st); junk := STRING_TO_DATE('tomorrow');`,
        steps: [{ expect: { st: 'TOD#07:05:09.500', d: 1709164800000, x: 1709164801000, back: 25509500, junk: 0 } }],
        divergence:
          'IEC fixes no spelling for a calendar value as text. A fraction of a second prints in milliseconds, three places; MATIEC prints six (TOD#07:05:09.500000). Text that is no date reads as 0 (1970-01-01, midnight), as STRING_TO_INT of text that is no number reads as 0.',
        oracle: { skip: "MATIEC prints a fraction of a second to six places, and its STRING_TO_DATE/_TOD/_DT are the same stub as its STRING_TO_TIME (lib/C/iec_std_lib.h: \"Quick hack : only transform seconds\"), so neither half has an answer to compare" },
      },
      {
        // MATIEC does not wrap a TOD at midnight (it keeps counting seconds past 86400, and its own
        // TOD_TO_STRING then prints "TOD#ERROR") and does not check it, so the value a program goes on
        // with is no time of day. Faulting is this engine's choice, as with an array bound.
        name: 'a TIME_OF_DAY pushed past midnight faults the scan',
        src: `VAR t : TOD := TOD#23:59:59; dur : TIME := T#2s; r : TOD; END_VAR
r := t + dur;`,
        steps: [{ throws: /past midnight/ }],
        divergence: 'This engine faults on a TOD result past 24:00:00, the same choice as for an array subscript or a subrange: the simulator is where the mistake is cheapest to find. MATIEC does not check a TOD result: it goes on past 24:00:00 with a value that is no time of day.',
        oracle: { skip: 'a scan fault has no comparable image: MATIEC computes 86401 s and runs on, which is the divergence itself' },
      },
      {
        name: 'a DATE_AND_TIME before 1970 faults the scan',
        src: `VAR x : DT := DT#1970-01-01-00:00:00; dur : TIME := T#1s; r : DT; END_VAR
r := SUB_DT_TIME(x, dur);`,
        steps: [{ throws: /before 1970-01-01/ }],
        divergence: "This engine's DT range is a 32-bit unsigned count of seconds from 1970, so it has no earlier instant, and a result before 1970 faults rather than hand a program a value an unsigned count cannot hold. MATIEC's count is signed and would go on.",
        oracle: { skip: 'a scan fault has no comparable image, and MATIEC, whose count is signed, runs on' },
      },
      {
        name: 'a DATE plus a TIME is rejected',
        src: 'VAR d : DATE := D#2024-01-01; r : DATE; END_VAR\nr := d + T#1h;',
        steps: [],
        rejects: /a DATE has no time of day to add a TIME to/,
      },
      {
        name: 'a TIME plus a TOD is rejected: the TOD comes first',
        src: 'VAR t : TOD; r : TOD; END_VAR\nr := T#1h + t;',
        steps: [],
        rejects: /write the TOD first/,
      },
      {
        name: 'a DATE compared with a DT is rejected',
        src: 'VAR d : DATE; x : DT; b : BOOL; END_VAR\nb := d < x;',
        steps: [],
        rejects: /cannot compare DATE with DT/,
      },
      {
        name: 'a DATE stored into a DT is rejected',
        src: 'VAR d : DATE; x : DT; END_VAR\nx := d;',
        steps: [],
        rejects: /cannot assign DATE to .* of type DT/,
      },
      {
        name: 'a plain number stored into a DATE is rejected',
        src: 'VAR d : DATE; END_VAR\nd := 5;',
        steps: [],
        rejects: /cannot assign INT to .* of type DATE/,
      },
      {
        name: 'a TIME_OF_DAY converted to a TIME is rejected',
        src: 'VAR t : TOD; r : TIME; END_VAR\nr := TOD_TO_TIME(t);',
        steps: [],
        rejects: /TOD_TO_TIME does not exist/,
      },
      {
        name: 'ADD of a duration and a plain number is rejected, as + is',
        src: 'VAR a : TIME := T#1s; r : TIME; END_VAR\nr := ADD(a, 5);',
        steps: [],
        rejects: /needs both operands to be TIME/,
      },
      {
        // Both reference compilers build this and disagree on the number (measured on D#2024-02-29):
        // MATIEC answers 1709164800, seconds since 1970; STruC++ 0.6.2, built and run, answers 19782, days.
        // DT and TOD disagree too (MATIEC seconds, STruC++ milliseconds). A number that means different
        // things on two targets is the portability defect this engine refuses, and the error says what to
        // write instead
        name: 'a date converted to a number is rejected: the reference compilers disagree on the unit',
        src: 'VAR d : DATE; n : DINT; END_VAR\nn := DATE_TO_DINT(d);',
        steps: [],
        rejects: /DATE_TO_DINT is not portable/,
        oracle: { skip: 'MATIEC builds it, counting in seconds since 1970, and STruC++ builds it counting in days: that disagreement is what the refusal is for, so neither has an answer that could agree' },
      },
      {
        // Measured by the MATIEC execute oracle: T#1500ms converts to 1 and T#90s to 90.
        // lib/C/iec_std_functions.h converts TIME through __time_to_int, which returns tv_sec.
        name: 'TIME_TO_DINT counts milliseconds',
        src: `VAR tm : TIME := T#1500ms; big : TIME := T#90s; END_VAR
VAR_OUTPUT ti : DINT; tb : DINT; END_VAR
ti := TIME_TO_DINT(tm); tb := TIME_TO_DINT(big);`,
        steps: [{ expect: { ti: 1500, tb: 90000 } }],
        divergence:
          'This engine counts a TIME converted to a number in milliseconds, the unit TIME carries everywhere else. STruC++ (T#1500ms converts to 1500 in 0.6.2) counts the same. MATIEC counts WHOLE SECONDS (T#1500ms is 1), so a program that converts a TIME to a number reads a different number on a MATIEC target such as OpenPLC v3.',
      },
      {
        // the other direction, which a program sets a timer's preset with from a number (PT := DINT_TO_TIME(n)).
        // Read back by comparing with TIME literals, because a round trip through TIME_TO_DINT would hide the unit.
        // Measured by the MATIEC execute oracle: both conversions of 1500 equal T#1500s, not T#1500ms; by
        // building this case with STruC++ 0.6.2 and running it, T#1500ms.
        name: 'DINT_TO_TIME and REAL_TO_TIME read the number as milliseconds',
        src: `VAR n : DINT := 1500; r : REAL := 1500.0; tn : TIME; tr : TIME; END_VAR
VAR_OUTPUT nMilli : BOOL; nSec : BOOL; rMilli : BOOL; rSec : BOOL; END_VAR
tn := DINT_TO_TIME(n); tr := REAL_TO_TIME(r);
nMilli := tn = T#1500ms; nSec := tn = T#1500s; rMilli := tr = T#1500ms; rSec := tr = T#1500s;`,
        steps: [{ expect: { nMilli: true, nSec: false, rMilli: true, rSec: false } }],
        divergence:
          'MATIEC reads a number converted to a TIME as SECONDS (DINT_TO_TIME(1500) and REAL_TO_TIME(1500.0) are T#1500s), the mirror of its TIME_TO_DINT. This engine reads milliseconds (STruC++ 0.6.2 agrees), so a preset converted from a number lasts 1000 times longer on a MATIEC target such as OpenPLC v3.',
      },
      {
        name: 'a date that does not exist is rejected',
        src: 'VAR d : DATE := D#2023-02-29; END_VAR\nd := d;',
        steps: [],
        rejects: /2023-02-29 is not a date/,
        oracle: { skip: 'MATIEC builds a nonexistent date and only rejects it when the initialisation runs (lib/C/iec_std_lib.h __date_to_timespec calls __iec_error), so its compile step has no answer to compare' },
      },
      {
        name: 'a TIME_OF_DAY of 24:00:00 is rejected',
        src: 'VAR t : TOD := TOD#24:00:00; END_VAR\nt := t;',
        steps: [],
        rejects: /hour 24 is not 0 to 23/,
        oracle: { skip: 'MATIEC builds it, as a TOD that is a whole day long; IEC\'s day_hour is 0 to 23, so the refusal is the standard\'s grammar' },
      },
    ],
  },
  {
    // A CONFIGURATION runs PROGRAM instances on tasks, each on its own interval. These cases step
    // Sim time: every step's dt is one tick of the fastest task, the tasks come due as their periods
    // elapse, and a task's first scan comes one full period in. The goldens follow from the periods
    // and from IEC's scheduling rule (a higher-priority task that is due runs first; a program with no
    // task has the lowest priority). The MATIEC harness numbers its ticks from 1 to match that phase,
    // which IEC leaves open (see src/plc/oracleShape.ts).
    title: 'tasks and programs: a CONFIGURATION runs PROGRAM instances on their own schedules',
    cases: [
      {
        name: 'each task scans on its own interval, one PROGRAM type in two instances',
        src: `PROGRAM Counter
VAR_OUTPUT n : INT; END_VAR
n := n + 1;
END_PROGRAM

CONFIGURATION Cell
  RESOURCE Res0 ON PLC
    TASK Fast(INTERVAL := T#10ms, PRIORITY := 1);
    TASK Slow(INTERVAL := T#30ms, PRIORITY := 2);
    PROGRAM FastCount WITH Fast : Counter;
    PROGRAM SlowCount WITH Slow : Counter;
  END_RESOURCE
END_CONFIGURATION`,
        steps: [
          { dt: 0.01, expect: { 'FastCount.n': 1, 'SlowCount.n': 0 } },
          { dt: 0.01, expect: { 'FastCount.n': 2, 'SlowCount.n': 0 } },
          { dt: 0.01, expect: { 'FastCount.n': 3, 'SlowCount.n': 1 } }, // 30 ms: the slow task's first period
          { dt: 0.01, expect: { 'FastCount.n': 4, 'SlowCount.n': 1 } },
          { dt: 0.01, expect: { 'FastCount.n': 5, 'SlowCount.n': 1 } },
          { dt: 0.01, expect: { 'FastCount.n': 6, 'SlowCount.n': 2 } },
        ],
      },
      {
        // The TASKs are declared low priority first, so running them in declaration order would let the
        // reader see the value from before the producer's scan: seen would trail shared by one.
        name: 'tasks due together run by PRIORITY, not in the order the TASKs are declared',
        src: `PROGRAM Producer
VAR_EXTERNAL shared : INT; END_VAR
shared := shared + 1;
END_PROGRAM

PROGRAM Consumer
VAR_EXTERNAL shared : INT; END_VAR
VAR_OUTPUT seen : INT; END_VAR
seen := shared;
END_PROGRAM

CONFIGURATION Cell
  VAR_GLOBAL shared : INT; END_VAR
  RESOURCE Res0 ON PLC
    TASK Low(INTERVAL := T#10ms, PRIORITY := 5);
    TASK High(INTERVAL := T#10ms, PRIORITY := 0);
    PROGRAM Maker WITH High : Producer;
    PROGRAM Reader WITH Low : Consumer;
  END_RESOURCE
END_CONFIGURATION`,
        steps: [
          { dt: 0.01, expect: { 'Reader.seen': 1 } },
          { dt: 0.01, expect: { 'Reader.seen': 2 } },
          { dt: 0.01, expect: { 'Reader.seen': 3 } },
        ],
      },
      {
        name: 'PRIORITY decides even when the PROGRAM lines are written the other way round',
        src: `PROGRAM Producer
VAR_EXTERNAL shared : INT; END_VAR
shared := shared + 1;
END_PROGRAM

PROGRAM Consumer
VAR_EXTERNAL shared : INT; END_VAR
VAR_OUTPUT seen : INT; END_VAR
seen := shared;
END_PROGRAM

CONFIGURATION Cell
  VAR_GLOBAL shared : INT; END_VAR
  RESOURCE Res0 ON PLC
    TASK Low(INTERVAL := T#10ms, PRIORITY := 5);
    TASK High(INTERVAL := T#10ms, PRIORITY := 0);
    PROGRAM Reader WITH Low : Consumer;
    PROGRAM Maker WITH High : Producer;
  END_RESOURCE
END_CONFIGURATION`,
        steps: [
          { dt: 0.01, expect: { 'Reader.seen': 1 } },
          { dt: 0.01, expect: { 'Reader.seen': 2 } },
        ],
        oracle: {
          skip: 'MATIEC ignores PRIORITY: for this file its generated RES0_run__ tests LOW and HIGH and then calls CONSUMER_body__(&READER) before PRODUCER_body__(&MAKER), in the order the PROGRAM lines are written (stage4/generate_c/generate_c.cc emits one gated call per line), so it has Reader see 0 and then 1. IEC gives the higher-priority task the processor first. The export warns when PROGRAM lines are out of priority order',
        },
      },
      {
        name: 'a PROGRAM instance with no task runs on every tick, after the periodic tasks',
        src: `PROGRAM Advance
VAR_EXTERNAL count : INT; END_VAR
count := count + 1;
END_PROGRAM

PROGRAM Idle
VAR k : INT; END_VAR
k := 0;
END_PROGRAM

PROGRAM Observe
VAR_EXTERNAL count : INT; END_VAR
VAR_OUTPUT runs : INT; seenCount : INT; END_VAR
runs := runs + 1;
seenCount := count;
END_PROGRAM

CONFIGURATION Cell
  VAR_GLOBAL count : INT; END_VAR
  RESOURCE Res0 ON PLC
    TASK Base(INTERVAL := T#10ms, PRIORITY := 1);
    TASK Every20(INTERVAL := T#20ms, PRIORITY := 2);
    PROGRAM Idler WITH Base : Idle;
    PROGRAM Stepper WITH Every20 : Advance;
    PROGRAM Watcher : Observe;
  END_RESOURCE
END_CONFIGURATION`,
        steps: [
          { dt: 0.01, expect: { 'Watcher.runs': 1, 'Watcher.seenCount': 0 } },
          { dt: 0.01, expect: { 'Watcher.runs': 2, 'Watcher.seenCount': 1 } }, // after this tick's Stepper scan
          { dt: 0.01, expect: { 'Watcher.runs': 3, 'Watcher.seenCount': 1 } },
          { dt: 0.01, expect: { 'Watcher.runs': 4, 'Watcher.seenCount': 2 } },
        ],
      },
      {
        // The timer is called once per slow scan, so its elapsed time moves in 50 ms steps: the scan that
        // sees the edge starts the clock at 0, as in the single-program TON case above.
        name: "a timer in a slow task measures that task's own period",
        src: `PROGRAM Idle
VAR k : INT; END_VAR
k := 0;
END_PROGRAM

PROGRAM Delay
VAR t : TON; END_VAR
VAR_OUTPUT q : BOOL; et : TIME; END_VAR
t(IN := TRUE, PT := T#100ms);
q := t.Q;
et := t.ET;
END_PROGRAM

CONFIGURATION Cell
  RESOURCE Res0 ON PLC
    TASK Base(INTERVAL := T#10ms, PRIORITY := 0);
    TASK Slow(INTERVAL := T#50ms, PRIORITY := 1);
    PROGRAM Idler WITH Base : Idle;
    PROGRAM Timer WITH Slow : Delay;
  END_RESOURCE
END_CONFIGURATION`,
        steps: [
          { dt: 0.01 },
          { dt: 0.01 },
          { dt: 0.01 },
          { dt: 0.01 },
          { dt: 0.01, expect: { 'Timer.q': false }, close: { 'Timer.et': 0 } }, // the first slow scan sees the edge
          { dt: 0.01 },
          { dt: 0.01 },
          { dt: 0.01 },
          { dt: 0.01 },
          { dt: 0.01, expect: { 'Timer.q': false }, close: { 'Timer.et': 50 } },
          { dt: 0.01 },
          { dt: 0.01 },
          { dt: 0.01 },
          { dt: 0.01 },
          { dt: 0.01, expect: { 'Timer.q': true }, close: { 'Timer.et': 100 } },
        ],
      },
      {
        // the global is not called `limit`: LIMIT is a standard function, and MATIEC's lexer
        // reserves those names in ST, the same limit as `lt` and `step`
        name: 'VAR_EXTERNAL reaches the global it names, from a function block and from the program',
        src: `VAR_GLOBAL ceiling : INT := 3; END_VAR

FUNCTION_BLOCK Clamp
VAR_EXTERNAL ceiling : INT; END_VAR
VAR_INPUT v : INT; END_VAR
VAR_OUTPUT q : INT; END_VAR
q := MIN(v, ceiling);
END_FUNCTION_BLOCK

VAR_EXTERNAL ceiling : INT; END_VAR
VAR c : Clamp; clamped : INT; END_VAR
c(v := 7, q => clamped);
ceiling := ceiling + 1;`,
        steps: [{ expect: { clamped: 3 } }, { expect: { clamped: 4 } }, { expect: { clamped: 5 } }],
      },
      {
        name: 'VAR_EXTERNAL CONSTANT reads a CONSTANT global',
        src: `VAR_GLOBAL CONSTANT ZONES : INT := 4; END_VAR
VAR_EXTERNAL CONSTANT ZONES : INT; END_VAR
VAR n : INT; END_VAR
n := ZONES * 2;`,
        steps: [{ expect: { n: 8 } }],
      },
      {
        // Code outside every POU beside a CONFIGURATION holds the top-level variables (this engine's extension):
        // every POU sees them, and the instance that names no type runs its statements. The
        // oracles compile the export, which writes that code as a PROGRAM of its own and its variables as
        // VAR_GLOBALs, since Watch names one. The timer measures a function-block instance kept that way.
        name: "code outside every POU holds the top-level variables: a PROGRAM reads them, and an instance with no type runs it",
        src: `PROGRAM Watch
VAR_EXTERNAL count : INT; END_VAR
VAR_OUTPUT seen : INT; END_VAR
seen := count;
END_PROGRAM

VAR count : INT; pulse : TON; END_VAR
pulse(IN := TRUE, PT := T#1s);
count := count + 1;

CONFIGURATION Cell
  RESOURCE Res0 ON PLC
    TASK Fast(INTERVAL := T#10ms, PRIORITY := 0);
    TASK Slow(INTERVAL := T#20ms, PRIORITY := 1);
    PROGRAM Main WITH Fast;
    PROGRAM Watcher WITH Slow : Watch;
  END_RESOURCE
END_CONFIGURATION`,
        steps: [
          { dt: 0.01, expect: { 'Watcher.seen': 0 } },
          { dt: 0.01, expect: { 'Watcher.seen': 2 } }, // 20 ms: both due, and Fast (priority 0) counts before Watcher reads
          { dt: 0.01, expect: { 'Watcher.seen': 2 } },
          { dt: 0.01, expect: { 'Watcher.seen': 4 } },
        ],
      },
      {
        name: 'rejects code outside every POU that no PROGRAM instance runs',
        src: `PROGRAM P
VAR n : INT; END_VAR
n := n + 1;
END_PROGRAM

VAR k : INT; END_VAR
k := k + 1;

CONFIGURATION Cell
  RESOURCE Res0 ON PLC
    TASK Main(INTERVAL := T#10ms, PRIORITY := 0);
    PROGRAM Inst WITH Main : P;
  END_RESOURCE
END_CONFIGURATION`,
        steps: [],
        rejects: /no PROGRAM instance runs that code/,
        oracle: { skip: OUTSIDE_EVERY_POU },
      },
      {
        name: 'rejects two PROGRAM instances that both run the code outside every POU',
        src: `VAR k : INT; END_VAR
k := k + 1;

CONFIGURATION Cell
  RESOURCE Res0 ON PLC
    TASK Main(INTERVAL := T#10ms, PRIORITY := 0);
    PROGRAM A WITH Main;
    PROGRAM B WITH Main;
  END_RESOURCE
END_CONFIGURATION`,
        steps: [],
        rejects: /'A' already runs it/,
        oracle: { skip: OUTSIDE_EVERY_POU },
      },
      {
        name: 'rejects a top-level variable named like a VAR_GLOBAL',
        src: `VAR k : INT; END_VAR
k := k + 1;

CONFIGURATION Cell
  VAR_GLOBAL k : INT; END_VAR
  RESOURCE Res0 ON PLC
    TASK Main(INTERVAL := T#10ms, PRIORITY := 0);
    PROGRAM A WITH Main;
  END_RESOURCE
END_CONFIGURATION`,
        steps: [],
        rejects: /top-level variable, and VAR_GLOBAL 'k' already has that name/,
        oracle: { skip: OUTSIDE_EVERY_POU },
      },
      {
        name: 'rejects a VAR_EXTERNAL that names no VAR_GLOBAL',
        src: 'VAR_EXTERNAL missing : INT; END_VAR\nVAR n : INT; END_VAR\nn := missing;',
        steps: [],
        rejects: /VAR_EXTERNAL 'missing' names no VAR_GLOBAL/,
      },
      {
        name: 'rejects a VAR_EXTERNAL of another type than its VAR_GLOBAL',
        src: 'VAR_GLOBAL g : INT; END_VAR\nVAR_EXTERNAL g : DINT; END_VAR\nVAR n : DINT; END_VAR\nn := g;',
        steps: [],
        rejects: /VAR_EXTERNAL 'g' is declared DINT, but the VAR_GLOBAL is INT/,
      },
      {
        name: 'rejects a non-CONSTANT VAR_EXTERNAL of a CONSTANT global',
        src: 'VAR_GLOBAL CONSTANT k : INT := 1; END_VAR\nVAR_EXTERNAL k : INT; END_VAR\nVAR n : INT; END_VAR\nn := k;',
        steps: [],
        rejects: /must be declared CONSTANT/,
      },
      {
        name: 'rejects a write through a VAR_EXTERNAL CONSTANT',
        src: 'VAR_GLOBAL g : INT; END_VAR\nVAR_EXTERNAL CONSTANT g : INT; END_VAR\ng := 1;',
        steps: [],
        rejects: /cannot assign to CONSTANT 'g'/,
      },
      {
        name: 'rejects a PROGRAM instance on a task nobody declared',
        src: `PROGRAM P
VAR n : INT; END_VAR
n := n + 1;
END_PROGRAM

CONFIGURATION Cell
  RESOURCE Res0 ON PLC
    TASK Main(INTERVAL := T#10ms, PRIORITY := 0);
    PROGRAM Inst WITH Missing : P;
  END_RESOURCE
END_CONFIGURATION`,
        steps: [],
        rejects: /unknown TASK 'Missing'/,
        oracle: {
          skip: "MATIEC's front end does not check the task an instance names: iec2c accepts this file and emits `if (MISSING) {` into Res0.c, which gcc then refuses (\"'MISSING' undeclared\"). So the program does not build on that toolchain either, but tier 1 stops at iec2c and would report the rule as over-strict. STruC++ refuses it outright",
        },
      },
      {
        name: 'rejects a PROGRAM instance of a FUNCTION_BLOCK',
        src: `FUNCTION_BLOCK Fb
VAR n : INT; END_VAR
n := n + 1;
END_FUNCTION_BLOCK

PROGRAM P
VAR k : INT; END_VAR
k := 1;
END_PROGRAM

CONFIGURATION Cell
  RESOURCE Res0 ON PLC
    TASK Main(INTERVAL := T#10ms, PRIORITY := 0);
    PROGRAM Inst WITH Main : P;
    PROGRAM Other WITH Main : Fb;
  END_RESOURCE
END_CONFIGURATION`,
        steps: [],
        rejects: /'Fb' is a FUNCTION_BLOCK, not a PROGRAM/,
      },
      {
        name: 'rejects a TASK with no PRIORITY',
        src: `PROGRAM P
VAR n : INT; END_VAR
n := n + 1;
END_PROGRAM

CONFIGURATION Cell
  RESOURCE Res0 ON PLC
    TASK Main(INTERVAL := T#10ms);
    PROGRAM Inst WITH Main : P;
  END_RESOURCE
END_CONFIGURATION`,
        steps: [],
        rejects: /needs a PRIORITY/,
      },
      {
        name: "rejects a TASK's arguments out of IEC's order",
        src: `PROGRAM P
VAR n : INT; END_VAR
n := n + 1;
END_PROGRAM

CONFIGURATION Cell
  RESOURCE Res0 ON PLC
    TASK Main(PRIORITY := 0, INTERVAL := T#10ms);
    PROGRAM Inst WITH Main : P;
  END_RESOURCE
END_CONFIGURATION`,
        steps: [],
        rejects: /order SINGLE, INTERVAL, PRIORITY/,
      },
      {
        name: 'rejects two PROGRAM instances with one name',
        src: `PROGRAM P
VAR n : INT; END_VAR
n := n + 1;
END_PROGRAM

CONFIGURATION Cell
  RESOURCE Res0 ON PLC
    TASK Main(INTERVAL := T#10ms, PRIORITY := 0);
    PROGRAM Inst WITH Main : P;
    PROGRAM Inst WITH Main : P;
  END_RESOURCE
END_CONFIGURATION`,
        steps: [],
        rejects: /duplicate program instance 'Inst'/,
      },
    ],
  },
  {
    // A LOCATED variable is bound to an I/O point by its address. The scene and an external controller
    // reach it by that address (located.test.ts pins the tag surface); here the program's own meaning
    // is checked, which is the same as any variable's once its value is written.
    title: 'located variables: AT binds a variable to an I/O point (%I, %Q) or to memory (%M)',
    cases: [
      {
        name: 'a located input and output behave as ordinary variables in the code',
        src: `VAR
  Eye AT %IX0.0 : BOOL;
  Run AT %QX0.0 : BOOL;
END_VAR
Run := NOT Eye;`,
        steps: [
          { in: { Eye: true }, expect: { Run: false } },
          { in: { Eye: false }, expect: { Run: true } },
        ],
      },
      {
        name: 'located byte, word and double-word variables carry their values',
        src: `VAR
  Count AT %IW2 : INT;
  Shown AT %QW0 : INT;
  Raw AT %IB1 : USINT;
  Doubled AT %QB1 : USINT;
  Level AT %ID0 : DINT;
  Sum AT %QD0 : DINT;
END_VAR
Shown := Count * 2;
Doubled := Raw * 2;
Sum := Level + 1;`,
        steps: [{ in: { Count: 21, Raw: 100, Level: 99999 }, expect: { Shown: 42, Doubled: 200, Sum: 100000 } }],
      },
      {
        // in a VAR block of its own: see the next case for why
        name: 'a located variable keeps its initial value until the I/O writes it',
        src: `VAR
  Lamp AT %QX1.3 : BOOL := TRUE;
END_VAR
VAR
  Hold : BOOL;
END_VAR
Hold := Lamp;`,
        steps: [{ expect: { Lamp: true, Hold: true } }],
      },
      {
        name: 'a located and an ordinary variable may share one VAR block',
        src: `VAR
  Eye AT %IX0.0 : BOOL;
  Seen : BOOL;
END_VAR
Seen := Eye;`,
        steps: [{ in: { Eye: true }, expect: { Seen: true } }],
        oracle: {
          editionReject:
            'MATIEC takes located declarations only in a VAR block of their own, as IEC\'s grammar writes them, and refuses this one ("invalid located variable declaration"). STruC++, the compiler OpenPLC ships, builds it; the export warns, so a program bound for a strict compiler can be split first',
        },
      },
      {
        name: 'rejects a type that does not fit its address',
        src: 'VAR a AT %IW0 : BOOL; END_VAR\na := TRUE;',
        steps: [],
        rejects: /'a' is BOOL, which does not fit the word address %IW0/,
      },
      {
        name: 'rejects two variables at one output',
        src: 'VAR a AT %QX0.0 : BOOL; b AT %QX0.0 : BOOL; END_VAR\na := TRUE;\nb := FALSE;',
        steps: [],
        rejects: /%QX0.0 is already the address of 'a'/,
      },
      {
        name: 'rejects a located variable in a function block',
        src: `FUNCTION_BLOCK Motor
VAR run AT %QX0.0 : BOOL; END_VAR
run := TRUE;
END_FUNCTION_BLOCK
VAR m : Motor; END_VAR
m();`,
        steps: [],
        rejects: /a function block cannot declare a located variable/,
      },
      {
        name: 'rejects a located VAR_INPUT, whose address already says the direction',
        src: 'VAR_INPUT a AT %IX0.0 : BOOL; END_VAR\nVAR b : BOOL; END_VAR\nb := a;',
        steps: [],
        rejects: /a located variable is declared in VAR/,
      },
      {
        // OpenPLC keeps a SCADA's values at %MW / %MD, so real programs carry these; the scene binds none of them
        name: 'memory addresses are storage the program keeps',
        src: `VAR
  Count AT %MW0 : INT;
  Total AT %MD1 : DINT;
  Flag AT %MX8.0 : BOOL;
END_VAR
VAR_INPUT
  Go : BOOL;
END_VAR
IF Go THEN
  Count := Count + 1;
  Total := Total + 10;
END_IF;
Flag := Count >= 2;`,
        steps: [
          { in: { Go: true }, expect: { Count: 1, Total: 10, Flag: false } },
          { in: { Go: false }, expect: { Count: 1, Total: 10, Flag: false } },
          { in: { Go: true }, expect: { Count: 2, Total: 20, Flag: true } },
        ],
      },
      {
        name: 'rejects two memory variables that share bytes',
        src: 'VAR w AT %MW0 : INT; b AT %MX1.2 : BOOL; END_VAR\nw := 1;',
        steps: [],
        rejects: /'b' at %MX1.2 shares memory with 'w' at %MW0/,
        oracle: {
          skip: 'a portability rule of this engine, not of IEC: the standard leaves overlapping memory to the implementation (one target may overlay the bytes, OpenPLC keeps each size in an area of its own), so no external compiler is expected to refuse it',
        },
      },
    ],
  },
  {
    // IEC 61131-3 3rd edition, 6.6.5 (methods, interfaces, inheritance) and 6.4.4.10 (references, REF_TO), on
    // FUNCTION_BLOCKs. The goldens are derived from the standard's rules - a method's variables are temporary, a call
    // through THIS or an interface runs the instance's own class's implementation, a derived block runs its own body
    // unless it calls SUPER^(), a REF_TO is dereferenced with ^ and may be NULL. MATIEC is 2nd edition and refuses all
    // of it; STruC++ (3rd edition) must build every case but the interface variables it does not have yet.
    title: 'object orientation and references: METHOD, EXTENDS, INTERFACE and REF_TO',
    cases: [
      {
        name: 'a METHOD runs on its instance: its result, outputs and in-outs, and variables that start over on every call',
        src: `FUNCTION_BLOCK Acc
  VAR n : INT; END_VAR
  METHOD Put : INT
    VAR_INPUT v : INT; END_VAR
    VAR_OUTPUT twice : INT; END_VAR
    VAR_IN_OUT tally : INT; END_VAR
    VAR calls : INT; END_VAR
    calls := calls + 1;
    n := n + v;
    twice := v * 2;
    tally := tally + calls;
    Put := n;
  END_METHOD
  METHOD Half : INT
    VAR_INPUT v : INT; END_VAR
    Half := v / 2;
  END_METHOD
  METHOD Reset
    n := 0;
  END_METHOD
END_FUNCTION_BLOCK
VAR_INPUT clear : BOOL; END_VAR
VAR a : Acc; r1 : INT; r2 : INT; w : INT; tl : INT; h : INT; END_VAR
IF clear THEN a.Reset(); END_IF;
r1 := a.Put(v := 3, twice => w, tally := tl);
r2 := a.Put(v := 4, tally := tl);
h := a.Half(r2);`,
        steps: [
          { expect: { r1: 3, r2: 7, w: 6, tl: 2, h: 3 } },
          { expect: { r1: 10, r2: 14, w: 6, tl: 4, h: 7 } },
          { in: { clear: true }, expect: { r1: 3, r2: 7, tl: 6, h: 3 } },
        ],
        oracle: { editionReject: OOP_EDITION },
      },
      {
        name: "EXTENDS: a derived block keeps its base's variables, overrides a method (SUPER^.M() reaches the base's), and runs its base's body only through SUPER^()",
        src: `FUNCTION_BLOCK Counter
  VAR_INPUT en : BOOL; END_VAR
  VAR_OUTPUT cnt : INT; END_VAR
  METHOD Gain : INT
    Gain := 1;
  END_METHOD
  METHOD Bump : INT
    cnt := cnt + Gain();
    Bump := cnt;
  END_METHOD
  IF en THEN cnt := cnt + 1; END_IF;
END_FUNCTION_BLOCK
FUNCTION_BLOCK Fast EXTENDS Counter
  VAR_OUTPUT twice : INT; END_VAR
  METHOD Gain : INT
    Gain := SUPER^.Gain() + 9;
  END_METHOD
  SUPER^();
  twice := cnt * 2;
END_FUNCTION_BLOCK
FUNCTION_BLOCK Quiet EXTENDS Counter
END_FUNCTION_BLOCK
VAR_INPUT go : BOOL; END_VAR
VAR slow : Counter; fast : Fast; quiet : Quiet; sl : INT; f : INT; d : INT; q : INT; b1 : INT; b2 : INT; END_VAR
slow(en := go, cnt => sl);
fast(en := go, cnt => f, twice => d);
quiet(en := go, cnt => q);
b1 := slow.Bump();
b2 := fast.Bump();`,
        steps: [
          // Bump is the base's method, and the Gain it calls is the instance's own class's: 1 for a Counter, 10 for a Fast
          { in: { go: true }, expect: { sl: 1, f: 1, d: 2, b1: 2, b2: 11, q: 0 } },
          { expect: { sl: 3, f: 12, d: 24, b1: 4, b2: 22, q: 0 } },
          { in: { go: false }, expect: { sl: 4, f: 22, d: 44, b1: 5, b2: 32, q: 0 } },
        ],
        oracle: { editionReject: OOP_EDITION },
      },
      {
        name: 'an ABSTRACT block leaves a method to the blocks derived from it, and its own methods call theirs',
        src: `FUNCTION_BLOCK ABSTRACT Shape
  METHOD ABSTRACT Area : REAL
  END_METHOD
  METHOD Twice : REAL
    Twice := 2.0 * Area();
  END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK FINAL Square EXTENDS Shape
  VAR_INPUT side : REAL; END_VAR
  METHOD OVERRIDE Area : REAL
    Area := side * side;
  END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK Rect EXTENDS Shape
  VAR_INPUT w : REAL; h : REAL; END_VAR
  METHOD Area : REAL
    Area := w * h;
  END_METHOD
END_FUNCTION_BLOCK
VAR sq : Square; re : Rect; a : REAL; b : REAL; END_VAR
sq(side := 3.0);
re(w := 2.0, h := 5.0);
a := sq.Twice();
b := re.Twice();`,
        steps: [{ expect: { a: 18, b: 20 } }],
        oracle: { editionReject: OOP_EDITION },
      },
      {
        name: 'rejects an override that takes other parameters than the method it replaces',
        src: `FUNCTION_BLOCK B
  METHOD Scale : INT
    VAR_INPUT x : INT; END_VAR
    Scale := x;
  END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK D EXTENDS B
  METHOD Scale : INT
    VAR_INPUT x : DINT; END_VAR
    Scale := 1;
  END_METHOD
END_FUNCTION_BLOCK`,
        steps: [],
        rejects: /method 'Scale' overrides the one of 'B', so it takes and returns exactly what that one does/,
        oracle: { skip: OOP_REJECT_UNCHECKABLE },
      },
      {
        name: 'rejects an instance of an ABSTRACT block',
        src: `FUNCTION_BLOCK ABSTRACT Shape
  METHOD ABSTRACT Area : REAL
  END_METHOD
END_FUNCTION_BLOCK
VAR s : Shape; END_VAR`,
        steps: [],
        rejects: /'Shape' is ABSTRACT, so nothing is an instance of it/,
        oracle: { skip: OOP_REJECT_UNCHECKABLE },
      },
      {
        name: 'REF_TO reads and writes, through ^, the place REF() gives it, an element and a field included, and a call gives a block\'s REF_TO input one',
        src: `TYPE Pkg : STRUCT id : INT; dest : INT; END_STRUCT; END_TYPE
FUNCTION_BLOCK Raise
  VAR_INPUT target : REF_TO INT; END_VAR
  target^ := target^ + 1;
END_FUNCTION_BLOCK
VAR_INPUT pick : INT; END_VAR
VAR a : INT := 5; b : INT := 50; zones : ARRAY [1..3] OF Pkg;
  ra : REF_TO INT; z : REF_TO Pkg; up : Raise;
  valid : BOOL; x : INT; id1 : INT; id2 : INT; d2 : INT; END_VAR
valid := ra <> NULL;
IF pick = 1 THEN ra := REF(a); ELSE ra := REF(b); END_IF;
ra^ := ra^ + 1;
x := ra^;
z := REF(zones[pick]);
z^.id := z^.id + 10;
up(target := REF(zones[2].dest));
id1 := zones[1].id;
id2 := zones[2].id;
d2 := zones[2].dest;`,
        steps: [
          { in: { pick: 1 }, expect: { valid: false, a: 6, b: 50, x: 6, id1: 10, id2: 0, d2: 1 } },
          { in: { pick: 2 }, expect: { valid: true, a: 6, b: 51, x: 51, id1: 10, id2: 10, d2: 2 } },
          { in: { pick: 1 }, expect: { valid: true, a: 7, b: 51, x: 7, id1: 20, id2: 10, d2: 3 } },
        ],
        oracle: { editionReject: OOP_EDITION },
      },
      {
        name: "a method called through a REF_TO a base class runs the class of the instance it refers to",
        src: `FUNCTION_BLOCK Base
  METHOD Gain : INT
    Gain := 1;
  END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK Child EXTENDS Base
  METHOD Gain : INT
    Gain := 3;
  END_METHOD
END_FUNCTION_BLOCK
VAR_INPUT useChild : BOOL; END_VAR
VAR c : Child; plain : Base; drive : REF_TO Base; g : INT; END_VAR
IF useChild THEN drive := REF(c); ELSE drive := REF(plain); END_IF;
g := drive^.Gain();`,
        steps: [
          { in: { useChild: true }, expect: { g: 3 } },
          { in: { useChild: false }, expect: { g: 1 } },
        ],
        oracle: {
          skip: 'no external compiler here runs it. MATIEC has no references; STruC++ 0.6.2 refuses a METHOD called through a dereferenced reference ("Expected `Semicolon`, found `(`" at drive^.Gain()) and does not build REF() of a function block either. The goldens are checked in-process, through both engines and the emitted TypeScript',
        },
      },
      {
        name: 'a REF_TO is given another\'s reference and NULL, passes either to a block\'s REF_TO input, and is compared with NULL',
        src: `FUNCTION_BLOCK Bump
  VAR_INPUT target : REF_TO INT; END_VAR
  VAR_OUTPUT seen : BOOL; END_VAR
  seen := target <> NULL;
  IF seen THEN target^ := target^ + 10; END_IF;
END_FUNCTION_BLOCK
VAR_INPUT clear : BOOL; END_VAR
VAR a : INT := 1; r1 : REF_TO INT; r2 : REF_TO INT; bump : Bump; has1 : BOOL; has2 : BOOL; hit : BOOL; END_VAR
r1 := REF(a);
r2 := r1;
r2^ := r2^ + 1;
IF clear THEN r1 := NULL; END_IF;
IF r1 = NULL THEN r2 := r1; END_IF;
has1 := r1 <> NULL;
has2 := r2 <> NULL;
bump(target := r2, seen => hit);`,
        steps: [
          { expect: { a: 12, has1: true, has2: true, hit: true } },
          { in: { clear: true }, expect: { a: 13, has1: false, has2: false, hit: false } },
          { in: { clear: false }, expect: { a: 24, has1: true, has2: true, hit: true } },
        ],
        oracle: { editionReject: OOP_EDITION },
      },
      {
        name: 'faults when a REF_TO that is NULL is dereferenced',
        src: 'VAR r : REF_TO INT; x : INT; END_VAR\nx := r^;',
        steps: [{ throws: /a REF_TO that is NULL was dereferenced/ }],
        divergence: 'IEC 61131-3 makes dereferencing a NULL reference an error and leaves what a controller then does to the implementation. This engine faults the scan, naming it, as it faults a subscript out of range; STruC++\'s runtime stops the POU the same way (its NullReference fault). MATIEC has no references',
        oracle: { skip: 'the fault is a null dereference in every compiled target: a scan fault has no comparable image, and asking an external run for one asks its harness to stop. The rule is pinned in-process, through both engines and the emitted TypeScript' },
      },
      {
        name: 'rejects REF() of a CONSTANT, which the reference would write through to',
        src: 'VAR CONSTANT limit : INT := 10; END_VAR\nVAR r : REF_TO INT; END_VAR\nr := REF(limit);',
        steps: [],
        rejects: /'r' cannot refer to CONSTANT 'limit'/,
        oracle: { skip: OOP_REJECT_UNCHECKABLE },
      },
      {
        name: 'an INTERFACE variable runs the implementation of the instance it refers to, and is passed to a block as an input',
        src: `INTERFACE IDrive
  METHOD Travel : INT
    VAR_INPUT dist : INT; END_VAR
  END_METHOD
END_INTERFACE
FUNCTION_BLOCK Belt IMPLEMENTS IDrive
  VAR p : INT; END_VAR
  METHOD Travel : INT
    VAR_INPUT dist : INT; END_VAR
    p := p + dist;
    Travel := p;
  END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK Lift IMPLEMENTS IDrive
  VAR h : INT; END_VAR
  METHOD Travel : INT
    VAR_INPUT dist : INT; END_VAR
    h := h + 10 * dist;
    Travel := h;
  END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK Mover
  VAR_INPUT drive : IDrive; END_VAR
  VAR_OUTPUT pos : INT; END_VAR
  IF drive <> 0 THEN pos := drive.Travel(dist := 1); END_IF;
END_FUNCTION_BLOCK
VAR_INPUT useLift : BOOL; END_VAR
VAR belt : Belt; lift : Lift; d : IDrive; mv : Mover; none : BOOL; res : INT; place : INT; END_VAR
none := d = 0;
IF useLift THEN d := lift; ELSE d := belt; END_IF;
res := d.Travel(dist := 2);
mv(drive := d, pos => place);`,
        steps: [
          { expect: { none: true, res: 2, place: 3 } },
          { in: { useLift: true }, expect: { none: false, res: 20, place: 30 } },
          { in: { useLift: false }, expect: { none: false, res: 5, place: 6 } },
        ],
        oracle: { skip: OOP_IFACE_UNCHECKABLE },
      },
      {
        name: 'faults a method called through an interface that refers to no instance',
        src: `INTERFACE IDrive
  METHOD Travel : INT
    VAR_INPUT dist : INT; END_VAR
  END_METHOD
END_INTERFACE
VAR d : IDrive; res : INT; END_VAR
res := d.Travel(dist := 1);`,
        steps: [{ throws: /through an interface that refers to no instance/ }],
        divergence: 'IEC 61131-3 makes a call through an interface that refers to no instance (NULL) an error and leaves what a controller then does to the implementation. This engine faults the scan, naming it, as it faults a NULL REF_TO dereferenced; a program tests `itf <> NULL` (or `<> 0`) first',
        oracle: { skip: OOP_IFACE_UNCHECKABLE },
      },
      {
        name: 'rejects an instance given to an interface its class does not implement',
        src: `INTERFACE IDrive
  METHOD Travel : INT
    VAR_INPUT dist : INT; END_VAR
  END_METHOD
END_INTERFACE
FUNCTION_BLOCK Lamp END_FUNCTION_BLOCK
VAR lamp : Lamp; d : IDrive; END_VAR
d := lamp;`,
        steps: [],
        rejects: /'lamp' is a Lamp, which does not implement IDrive/,
        oracle: { skip: OOP_REJECT_UNCHECKABLE },
      },
      {
        name: 'a method returns a whole structure, by value, and takes one as an input',
        src: `TYPE Pkg : STRUCT id : INT; dest : INT; END_STRUCT; END_TYPE
FUNCTION_BLOCK Sorter
  VAR n : INT; END_VAR
  METHOD Make : Pkg
    VAR_INPUT id : INT; END_VAR
    n := n + 1;
    Make.id := id;
    Make.dest := n;
  END_METHOD
  METHOD Weigh : INT
    VAR_INPUT p : Pkg; END_VAR
    Weigh := p.id * 10 + p.dest;
  END_METHOD
END_FUNCTION_BLOCK
VAR srt : Sorter; box : Pkg; id : INT; dest : INT; w : INT; END_VAR
box := srt.Make(id := 7);
id := box.id;
dest := box.dest;
w := srt.Weigh(p := srt.Make(id := 3));`,
        steps: [{ expect: { id: 7, dest: 1, w: 32 } }, { expect: { id: 7, dest: 3, w: 34 } }],
        oracle: { editionReject: OOP_EDITION },
      },
      {
        name: 'an ARRAY OF an interface: a loop calls the implementation of each instance an element refers to, and skips an empty one',
        src: `INTERFACE IDrive
  METHOD Travel : INT
    VAR_INPUT dist : INT; END_VAR
  END_METHOD
END_INTERFACE
FUNCTION_BLOCK Belt IMPLEMENTS IDrive
  VAR p : INT; END_VAR
  METHOD Travel : INT
    VAR_INPUT dist : INT; END_VAR
    p := p + dist;
    Travel := p;
  END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK Lift IMPLEMENTS IDrive
  VAR h : INT; END_VAR
  METHOD Travel : INT
    VAR_INPUT dist : INT; END_VAR
    h := h + 10 * dist;
    Travel := h;
  END_METHOD
END_FUNCTION_BLOCK
VAR drives : ARRAY [0..3] OF IDrive; b1 : Belt; b2 : Belt; lf : Lift; i : INT; total : INT; live : INT; END_VAR
drives[0] := b1;
drives[1] := lf;
drives[3] := b2;
total := 0;
live := 0;
FOR i := 0 TO 3 DO
  IF drives[i] <> 0 THEN
    live := live + 1;
    total := total + drives[i].Travel(dist := i + 1);
  END_IF;
END_FOR;`,
        steps: [{ expect: { total: 25, live: 3 } }, { expect: { total: 50, live: 3 } }],
        oracle: { skip: OOP_IFACE_UNCHECKABLE },
      },
      {
        name: 'rejects an ARRAY OF REF_TO, which this engine does not implement',
        src: 'VAR a : INT; refs : ARRAY [1..3] OF REF_TO INT; END_VAR\na := 1;',
        steps: [],
        rejects: /an ARRAY OF REF_TO is not implemented/,
        oracle: {
          skip: 'a limit of this engine, not a rule of IEC 61131-3, which allows an array of references: no external compiler is expected to refuse it',
        },
      },
    ],
  },
  {
    // Ladder Diagram (ladder.ts), IEC 61131-3 8.2. The goldens follow the element definitions of 8.2.3-8.2.4 by
    // hand, as every case here does. The text form is this engine's, so the ST oracles see these only through
    // the ST a rung lowers to, which proves nothing about LD itself; the goldens are checked in-process.
    title: 'ladder diagram',
    cases: [
      {
        name: 'ladder: a seal-in circuit latches through its own contact',
        src: `VAR_INPUT Start, Stop : BOOL; END_VAR VAR_OUTPUT Motor : BOOL; END_VAR
LADDER
  [|Start|, |Motor|] |/Stop| (Motor);
END_LADDER`,
        steps: [
          { in: { Start: true }, expect: { Motor: true } },
          { in: { Start: false }, expect: { Motor: true } },
          { in: { Stop: true }, expect: { Motor: false } },
          { in: { Stop: false }, expect: { Motor: false } },
        ],
        oracle: { skip: LADDER_TEXT },
      },
      {
        // a jump (8.2.6): while its left link is on, the rungs between it and its label are not evaluated, so
        // their coils hold what they last wrote, and the labelled rung runs as usual
        name: 'ladder: a jump steps over the rungs down to its label',
        src: `VAR_INPUT Skip, A : BOOL; END_VAR VAR_OUTPUT X, Y, Z : BOOL; END_VAR
LADDER
  |Skip| >>Past;
  |A| (X);
  |A| (Y);
  Past: |A| (Z);
END_LADDER`,
        steps: [
          { in: { A: true }, expect: { X: true, Y: true, Z: true } },
          { in: { Skip: true, A: false }, expect: { X: true, Y: true, Z: false } },
          { in: { Skip: false }, expect: { X: false, Y: false, Z: false } },
        ],
        oracle: { skip: LADDER_TEXT },
      },
      {
        // what stands before the jump on its own rung runs first; a jump straight from the rail always goes
        name: "ladder: a jump's own rung runs up to it, and one from the rail always jumps",
        src: `VAR_INPUT A : BOOL; END_VAR VAR_OUTPUT X, Y, Z, W : BOOL; END_VAR
LADDER
  |A| (X) >>Done;
  (Y);
  Done: |A| (Z);
  >>Out;
  (W);
  Out: ;
END_LADDER`,
        steps: [
          { in: { A: true }, expect: { X: true, Y: false, Z: true, W: false } },
          { in: { A: false }, expect: { X: false, Y: true, Z: false, W: false } },
        ],
        oracle: { skip: LADDER_TEXT },
      },
      {
        // two jumps over the same rungs, landing in different places: a rung runs only when no jump spans it
        name: 'ladder: overlapping jumps each step over their own stretch',
        src: `VAR_INPUT J1, J2, A : BOOL; END_VAR VAR_OUTPUT X1, X2, X3 : BOOL; END_VAR
LADDER
  |J1| >>L2;
  |J2| >>L1;
  |A| (X1);
  L1: |A| (X2);
  L2: |A| (X3);
END_LADDER`,
        steps: [
          { in: { A: true }, expect: { X1: true, X2: true, X3: true } },
          { in: { J2: true, A: false }, expect: { X1: true, X2: false, X3: false } },
          // J1 spans X1 and X2, so both hold what step 2 left them; X3, at J1's label, runs
          { in: { J2: false, J1: true }, expect: { X1: true, X2: false, X3: false } },
          { in: { A: true }, expect: { X1: true, X2: false, X3: true } },
        ],
        oracle: { skip: LADDER_TEXT },
      },
      {
        // the standard functions ST spells as operators (Tables 28-29) as boxes, as every LD editor has them: each runs
        // behind EN like any function, so with the rung off it is not called and its output holds
        name: 'ladder: AND, OR, XOR, NOT and MOD as boxes',
        src: `VAR_INPUT En, A, B : BOOL; N : INT; END_VAR VAR_OUTPUT Every, Some, Odd, Inv : BOOL; Rem : INT; END_VAR
LADDER
  |En| AND(IN1 := A, IN2 := B, IN3 := En, OUT => Every) OR(IN1 := A, IN2 := B, OUT => Some);
  |En| XOR(IN1 := A, IN2 := B, OUT => Odd) NOT(IN := A, OUT => Inv) MOD(IN1 := N, IN2 := 4, OUT => Rem);
END_LADDER`,
        steps: [
          { in: { En: true, A: true, B: false, N: 10 }, expect: { Every: false, Some: true, Odd: true, Inv: false, Rem: 2 } },
          { in: { B: true, N: 7 }, expect: { Every: true, Some: true, Odd: false, Inv: false, Rem: 3 } },
          { in: { En: false, A: false, N: 5 }, expect: { Every: true, Some: true, Odd: false, Inv: false, Rem: 3 } },
          { in: { En: true }, expect: { Every: false, Some: true, Odd: true, Inv: true, Rem: 1 } },
        ],
        oracle: { skip: LADDER_TEXT },
      },
      {
        name: 'ladder: RETURN ends the POU for the scan while its rung is on',
        src: `VAR_INPUT Hold, A : BOOL; END_VAR VAR_OUTPUT X : BOOL; END_VAR
LADDER
  |Hold| RETURN;
  |A| (X);
END_LADDER`,
        steps: [
          { in: { A: true }, expect: { X: true } },
          { in: { Hold: true, A: false }, expect: { X: true } },
          { in: { Hold: false }, expect: { X: false } },
        ],
        oracle: { skip: LADDER_TEXT },
      },
      {
        name: 'ladder: rejects a jump back up the section',
        src: `VAR_INPUT A : BOOL; END_VAR VAR_OUTPUT X : BOOL; END_VAR
LADDER
  Top: |A| (X);
  |A| >>Top;
END_LADDER`,
        steps: [],
        rejects: /a jump back up to 'Top' \(rung 0\) would run rungs again in one scan/,
        oracle: { skip: LADDER_TEXT },
      },
      {
        name: 'ladder: rejects a jump to a label no rung has',
        src: `VAR_INPUT A : BOOL; END_VAR
LADDER
  |A| >>Nowhere;
END_LADDER`,
        steps: [],
        rejects: /there is no rung labelled 'Nowhere'/,
        oracle: { skip: LADDER_TEXT },
      },
      {
        name: 'ladder: rejects a jump inside a branch',
        src: `VAR_INPUT A, B : BOOL; END_VAR VAR_OUTPUT X : BOOL; END_VAR
LADDER
  [|A| >>Out, |B|] (X);
  Out: ;
END_LADDER`,
        steps: [],
        rejects: /a jump or a RETURN ends a rung, after everything on it/,
        oracle: { skip: LADDER_TEXT },
      },
      {
        // a coil copies its left link to its variable AND to its right link (8.2.4), so outputs stand in series,
        // and the contact after one reads what it just wrote
        name: 'ladder: a coil passes its left link on, and a contact after it reads what it wrote',
        src: `VAR_INPUT A : BOOL; END_VAR VAR_OUTPUT B, C, D : BOOL; END_VAR
LADDER
  |A| (B) |B| (C);
  |A| (/B) (D);
END_LADDER`,
        steps: [
          { in: { A: true }, expect: { B: false, C: true, D: true } },
          { in: { A: false }, expect: { B: true, C: false, D: false } },
        ],
        oracle: { skip: LADDER_TEXT },
      },
      {
        // what flows right of a coil is its left link, which was computed before the coil wrote: rewriting the very
        // variable the rung examined does not change it
        name: 'ladder: what flows past a coil is what its rung examined, not what the coil wrote',
        src: `VAR_OUTPUT flip, seen : BOOL; END_VAR
LADDER
  |flip| (/flip) (seen);
END_LADDER`,
        steps: [
          { expect: { flip: true, seen: false } },
          { expect: { flip: false, seen: true } },
          { expect: { flip: true, seen: false } },
        ],
        oracle: { skip: LADDER_TEXT },
      },
      {
        // IEC leaves the order of a branch's paths open; this engine runs the paths holding a contact first and the
        // paths of plain coils after them, so here the contact examines X as it was: Y is
        // A AND the previous scan's X
        name: 'ladder: a branch runs its contact paths before its coil paths',
        src: `VAR_INPUT A : BOOL; END_VAR VAR_OUTPUT X, Y : BOOL; END_VAR
LADDER
  |A| [(X), |X| (Y)];
END_LADDER`,
        steps: [
          { in: { A: true }, expect: { X: true, Y: false } },
          { expect: { X: true, Y: true } },
          { in: { A: false }, expect: { X: false, Y: false } },
        ],
        oracle: { skip: LADDER_TEXT },
      },
      {
        // ...and paths that both hold a contact run top to bottom, so the second sees what the first wrote
        name: 'ladder: branch paths that both hold contacts run top to bottom',
        src: `VAR_INPUT A : BOOL; END_VAR VAR_OUTPUT X, Y : BOOL; END_VAR
LADDER
  |A| [|A| (X), |X| (Y)];
END_LADDER`,
        steps: [
          { in: { A: true }, expect: { X: true, Y: true } },
          { in: { A: false }, expect: { X: false, Y: false } },
        ],
        oracle: { skip: LADDER_TEXT },
      },
      {
        // a transition-sensing contact senses its variable from one evaluation to the next (8.2.3, Table 60),
        // whatever its left link is doing: the rise on scan 5 happens with `en` off, is sensed, and is gone
        name: 'ladder: P and N contacts sense a change of their variable once',
        src: `VAR_INPUT en, btn : BOOL; END_VAR VAR_OUTPUT up, down : BOOL; END_VAR
LADDER
  |en| |P btn| (up);
  |N btn| (down);
END_LADDER`,
        steps: [
          { in: { en: true, btn: false }, expect: { up: false, down: false } },
          { in: { btn: true }, expect: { up: true, down: false } },
          { expect: { up: false, down: false } },
          { in: { btn: false }, expect: { up: false, down: true } },
          { in: { en: false, btn: true }, expect: { up: false, down: false } },
          { in: { en: true }, expect: { up: false, down: false } },
          { in: { btn: false }, expect: { up: false, down: true } },
        ],
        oracle: { skip: LADDER_TEXT },
      },
      {
        // a transition-sensing coil senses its left link (8.2.4, Table 61) and passes the link on unchanged
        name: 'ladder: P and N coils pulse on a change of their left link',
        src: `VAR_INPUT A : BOOL; END_VAR VAR_OUTPUT up, down, same : BOOL; END_VAR
LADDER
  |A| (P up) (N down) (same);
END_LADDER`,
        steps: [
          { in: { A: false }, expect: { up: false, down: false, same: false } },
          { in: { A: true }, expect: { up: true, down: false, same: true } },
          { expect: { up: false, down: false, same: true } },
          { in: { A: false }, expect: { up: false, down: true, same: false } },
          { expect: { up: false, down: false, same: false } },
        ],
        oracle: { skip: LADDER_TEXT },
      },
      {
        // SET and RESET coils hold their variable; energized in the same scan, the one evaluated last wins
        name: 'ladder: set and reset coils latch, and the later rung wins',
        src: `VAR_INPUT go, halt : BOOL; END_VAR VAR_OUTPUT run : BOOL; END_VAR
LADDER
  |go| (S run);
  |halt| (R run);
END_LADDER`,
        steps: [
          { in: { go: true }, expect: { run: true } },
          { in: { go: false }, expect: { run: true } },
          { in: { go: true, halt: true }, expect: { run: false } },
          { in: { go: false, halt: false }, expect: { run: false } },
          { in: { go: true }, expect: { run: true } },
        ],
        oracle: { skip: LADDER_TEXT },
      },
      {
        // the rung feeds the timer's first BOOL input and carries its first BOOL output on; the timing is the
        // TON case's, which MATIEC holds
        name: 'ladder: a timer box takes the rung on IN and carries Q on',
        src: `VAR_INPUT go : BOOL; END_VAR VAR_OUTPUT late : BOOL; END_VAR VAR t : TON; END_VAR
LADDER
  |go| t(IN, PT := T#0.3s) (late);
END_LADDER`,
        steps: [
          { in: { go: true }, expect: { late: false } },
          { expect: { late: false } },
          { expect: { late: false } },
          { expect: { late: true } },
          { in: { go: false }, expect: { late: false } },
        ],
        oracle: { skip: LADDER_TEXT },
      },
      {
        // the same box with a preset a few scans long, so that a run at a PLC's own cycle time (a 10 ms task, say)
        // crosses it too: at the corpus's 100 ms scan, Q is on from the second scan
        name: 'ladder: a short timer on the rung turns on within the run',
        src: `VAR_INPUT go : BOOL; END_VAR VAR_OUTPUT late : BOOL; END_VAR VAR t : TON; END_VAR
LADDER
  |go| t(IN, PT := T#40ms) (late);
END_LADDER`,
        steps: [
          { in: { go: true }, expect: { late: false } },
          { expect: { late: true } },
          { expect: { late: true } },
          { expect: { late: true } },
          { expect: { late: true } },
          { expect: { late: true } },
          { expect: { late: true } },
          { in: { go: false }, expect: { late: false } },
        ],
        oracle: { skip: LADDER_TEXT },
      },
      {
        // a bare pin name puts that pin on the rung: here the counter's reset, its count coming in by value
        name: 'ladder: a counter with its reset on the rung and its output bound by name',
        src: `VAR_INPUT clear, pulse : BOOL; END_VAR VAR_OUTPUT full : BOOL; cv : INT; END_VAR VAR c : CTU; END_VAR
LADDER
  |clear| c(R, CU := pulse, PV := 2, CV => cv, Q) (full);
END_LADDER`,
        steps: [
          { in: { pulse: true }, expect: { cv: 1, full: false } },
          { in: { pulse: false }, expect: { cv: 1, full: false } },
          { in: { pulse: true }, expect: { cv: 2, full: true } },
          { in: { clear: true }, expect: { cv: 0, full: false } },
          { in: { clear: false, pulse: false }, expect: { cv: 0, full: false } },
        ],
        oracle: { skip: LADDER_TEXT },
      },
      {
        // EN / ENO: the function runs only while the rung is on, and ENO carries the rung on
        name: 'ladder: a function box runs on EN, stores OUT, and passes the rung on',
        src: `VAR_INPUT go : BOOL; END_VAR VAR_OUTPUT seen : BOOL; count : INT; END_VAR
LADDER
  |go| ADD(IN1 := count, IN2 := 1, OUT => count) (seen);
END_LADDER`,
        steps: [
          { in: { go: true }, expect: { count: 1, seen: true } },
          { expect: { count: 2, seen: true } },
          { in: { go: false }, expect: { count: 2, seen: false } },
          { in: { go: true }, expect: { count: 3, seen: true } },
        ],
        oracle: { skip: LADDER_TEXT },
      },
      {
        // a block behind EN is not called while the rung is off: its edge memory only sees the scans it runs on, so
        // the pulse that came and went while `go` was off (scans 3-4) is never counted
        name: 'ladder: a block with EN on the rung runs only while the rung is on',
        src: `VAR_INPUT go, pulse : BOOL; END_VAR VAR_OUTPUT done : BOOL; cv : INT; END_VAR VAR c : CTU; END_VAR
LADDER
  |go| c(EN, CU := pulse, PV := 5, CV => cv) (done);
END_LADDER`,
        steps: [
          { in: { go: true, pulse: true }, expect: { cv: 1, done: true } },
          { in: { pulse: false }, expect: { cv: 1, done: true } },
          { in: { go: false, pulse: true }, expect: { cv: 1, done: false } },
          { in: { pulse: false }, expect: { cv: 1, done: false } },
          { in: { go: true }, expect: { cv: 1, done: true } },
          { in: { pulse: true }, expect: { cv: 2, done: true } },
        ],
        oracle: { skip: LADDER_TEXT },
      },
      {
        // ...but a timer behind EN still measures the time the rung was off: it reads the clock, not the calls that
        // reach it. It starts on scan 1 and is next called on scan 15. The rung stays off long enough that its PT
        // passes at a short PLC cycle (10-16 ms) as well as at the corpus's 100 ms, where one call's worth of time
        // falls short of PT at both.
        name: 'ladder: a timer with EN on the rung measures the time the rung was off',
        src: `VAR_INPUT run, go : BOOL; END_VAR VAR_OUTPUT late : BOOL; END_VAR VAR t : TON; END_VAR
LADDER
  |run| t(EN, IN := go, PT := T#120ms, Q => late);
END_LADDER`,
        steps: [
          { in: { run: true, go: true }, expect: { late: false } }, // the edge scan starts the clock
          { in: { run: false }, expect: { late: false } },
          ...Array.from({ length: 12 }, () => ({ expect: { late: false } })), // the rung stays off
          { in: { run: true }, expect: { late: true } },
          { in: { go: false }, expect: { late: false } },
        ],
        oracle: { skip: LADDER_TEXT },
      },
      {
        // a function with a BOOL result can start a rung, its result bare (OUT): nothing feeds it, and what it returns
        // is the rung from there on: its operands come from variables and the rail links to none of its pins
        name: 'ladder: a comparison starts a rung, and the contacts after it are in series',
        src: `VAR_INPUT n : INT; a : BOOL; END_VAR VAR_OUTPUT q : BOOL; END_VAR
LADDER
  GT(IN1 := n, IN2 := 5, OUT) |a| (q);
END_LADDER`,
        steps: [
          { in: { n: 6, a: true }, expect: { q: true } },
          { in: { n: 5 }, expect: { q: false } },
          { in: { n: 9, a: false }, expect: { q: false } },
          { in: { a: true }, expect: { q: true } },
        ],
        oracle: { skip: LADDER_TEXT },
      },
      {
        // ...and any path of a branch that stands at the left rail, beside a contact or another comparison: an OR.
        // Valid IEC; some importers may not accept it, so the PLCopen export warns. These goldens are the element
        // definitions', held in-process only
        name: 'ladder: comparisons on a branch at the left rail',
        src: `VAR_INPUT n : INT; b : BOOL; END_VAR VAR_OUTPUT q, w : BOOL; END_VAR
LADDER
  [GT(IN1 := n, IN2 := 5, OUT), |b|] (q);
  [LT(IN1 := n, IN2 := 2, OUT), EQ(IN1 := n, IN2 := 4, OUT)] (w);
END_LADDER`,
        steps: [
          { in: { n: 6 }, expect: { q: true, w: false } },
          { in: { n: 4 }, expect: { q: false, w: true } },
          { in: { n: 1, b: true }, expect: { q: true, w: true } },
          { in: { n: 3, b: false }, expect: { q: false, w: false } },
        ],
        oracle: { skip: LADDER_TEXT },
      },
      {
        // the rail reaches a nested branch's paths too: q is ((n > 5) OR c) AND d, OR b
        name: 'ladder: a comparison on a branch nested at the left rail',
        src: `VAR_INPUT n : INT; b, c, d : BOOL; END_VAR VAR_OUTPUT q : BOOL; END_VAR
LADDER
  [[GT(IN1 := n, IN2 := 5, OUT), |c|] |d|, |b|] (q);
END_LADDER`,
        steps: [
          { in: { n: 6, d: true }, expect: { q: true } },
          { in: { d: false }, expect: { q: false } },
          { in: { b: true }, expect: { q: true } },
          { in: { b: false, c: true, d: true, n: 0 }, expect: { q: true } },
          { in: { c: false }, expect: { q: false } },
        ],
        oracle: { skip: LADDER_TEXT },
      },
      {
        // a step sequencer, the shape a ladder state machine takes: each rung tests the state and moves it on. A rung's
        // comparison is what it examined, though the rung then writes the state, and a scan runs the rungs in order, so
        // one scan can take two steps (0 to 10 to 20)
        name: 'ladder: a step sequencer moves on in the rung that tests the step',
        src: `VAR_INPUT go : BOOL; END_VAR VAR_OUTPUT step : INT; busy : BOOL; END_VAR
LADDER
  EQ(IN1 := step, IN2 := 0, OUT) |go| MOVE(IN := 10, OUT => step);
  EQ(IN1 := step, IN2 := 10, OUT) MOVE(IN := 20, OUT => step) (busy);
  EQ(IN1 := step, IN2 := 20, OUT) |/go| MOVE(IN := 0, OUT => step);
END_LADDER`,
        steps: [
          { in: { go: true }, expect: { step: 20, busy: true } },
          { expect: { step: 20, busy: false } },
          { in: { go: false }, expect: { step: 0, busy: false } },
          { expect: { step: 0, busy: false } },
          { in: { go: true }, expect: { step: 20, busy: true } },
        ],
        oracle: { skip: LADDER_TEXT },
      },
      {
        // a user FUNCTION returning BOOL is one too
        name: 'ladder: a user function with a BOOL result starts a rung',
        src: `FUNCTION InRange : BOOL
VAR_INPUT x, lo, hi : INT; END_VAR
InRange := (x >= lo) AND (x <= hi);
END_FUNCTION
VAR_INPUT n : INT; END_VAR VAR_OUTPUT q : BOOL; END_VAR
LADDER
  InRange(x := n, lo := 1, hi := 5, OUT) (q);
END_LADDER`,
        steps: [
          { in: { n: 3 }, expect: { q: true } },
          { in: { n: 7 }, expect: { q: false } },
          { in: { n: 1 }, expect: { q: true } },
        ],
        oracle: { skip: LADDER_TEXT },
      },
      {
        // a user FUNCTION_BLOCK on the rung, the shape Insert Box puts one in (ladderCatalog.ts `catalogItem`): fed by
        // its first BOOL input, the rung carried on by its first BOOL output, its other pins bound by name; and one with
        // no BOOL pair, which sits on the rung by EN / ENO, so with the rung off it is not called and its output holds.
        // Mover is called every scan (the rung feeds Enable, it does not gate the call), so its Pos stands still while
        // go is off; Tally's Total stands still because it was not called at all
        name: 'ladder: user function blocks on the rung, by a BOOL pair and by EN',
        src: `FUNCTION_BLOCK Mover
VAR_INPUT Enable : BOOL; Speed : INT; END_VAR
VAR_OUTPUT Done : BOOL; Pos : INT; END_VAR
IF Enable THEN Pos := Pos + Speed; END_IF;
Done := Pos >= 10;
END_FUNCTION_BLOCK
FUNCTION_BLOCK Tally
VAR_INPUT N : INT; END_VAR
VAR_OUTPUT Total : INT; END_VAR
Total := Total + N;
END_FUNCTION_BLOCK
VAR_INPUT go : BOOL; spd : INT; END_VAR VAR_OUTPUT q : BOOL; p, tot : INT; END_VAR VAR M : Mover; C : Tally; END_VAR
LADDER
  |go| M(Enable, Speed := spd, Pos => p) (q);
  |go| C(EN, N := spd, Total => tot);
END_LADDER`,
        steps: [
          { in: { go: true, spd: 4 }, expect: { q: false, p: 4, tot: 4 } },
          { expect: { q: false, p: 8, tot: 8 } },
          { in: { go: false }, expect: { q: false, p: 8, tot: 8 } },
          { in: { go: true }, expect: { q: true, p: 12, tot: 12 } },
        ],
        oracle: { skip: LADDER_TEXT },
      },
      {
        // anywhere but the left rail, its left link would lead nowhere
        name: 'ladder: rejects a comparison that does not stand at the left rail',
        src: `VAR_INPUT n : INT; a : BOOL; END_VAR VAR_OUTPUT q : BOOL; END_VAR
LADDER
  |a| GT(IN1 := n, IN2 := 5, OUT) (q);
END_LADDER`,
        steps: [],
        rejects: /nothing feeds it, so it stands at the left rail/,
        oracle: { skip: LADDER_TEXT },
      },
      {
        name: 'ladder: rejects a contact on a number',
        src: `VAR_INPUT n : INT; END_VAR VAR_OUTPUT q : BOOL; END_VAR
LADDER
  |n| (q);
END_LADDER`,
        steps: [],
        rejects: /a contact examines a BOOL, and 'n' is INT/,
        oracle: { skip: LADDER_TEXT },
      },
      {
        name: 'ladder: rejects a coil on a number',
        src: `VAR_INPUT a : BOOL; END_VAR VAR_OUTPUT level : REAL; END_VAR
LADDER
  |a| (level);
END_LADDER`,
        steps: [],
        rejects: /a coil writes a BOOL, and 'level' is REAL/,
        oracle: { skip: LADDER_TEXT },
      },
    ],
  },
  {
    // Input forms that strict IEC does not have: tolerated here (our rule for each) so code written elsewhere pastes, and
    // written back in the form every compiler reads (exportText.ts `canonicalSyntax`). The oracles render each case
    // through that exporter, so MATIEC and STruC++ building it is the proof that the canonical form means what the
    // input form ran as here.
    title: 'tolerated input forms, exported in IEC form',
    cases: [
      {
        name: 'a block statement or a data type closes without its ;',
        src: `TYPE Pt :
STRUCT
  x : INT;
END_STRUCT
END_TYPE
TYPE Mode : (Idle, Run) END_TYPE
VAR p : Pt; m : Mode := Run; a : INT; b : INT; i : INT; n : INT; END_VAR
IF m = Run THEN a := 1; END_IF
CASE a OF 1: b := 2; END_CASE
FOR i := 1 TO 3 DO n := n + 1; END_FOR
WHILE n < 10 DO n := n + 1; END_WHILE
REPEAT n := n + 1; UNTIL n > 11 END_REPEAT
IF a = 1 THEN IF b = 2 THEN p.x := 5; END_IF END_IF
a := p.x;`,
        steps: [{ expect: { a: 5, b: 2, n: 12 } }],
      },
      {
        name: 'a STRUCT field default starts every value of the type, under what an initializer names',
        src: `TYPE Axis :
STRUCT
  Speed : REAL := 1.5;
  Limit : INT := 100;
  Raw : INT;
END_STRUCT
END_TYPE
TYPE Cell :
STRUCT
  A : Axis;
  B : Axis;
  Arr : ARRAY [1..2] OF Axis;
END_STRUCT
END_TYPE
FUNCTION_BLOCK Holder
VAR_OUTPUT lim : INT; END_VAR
VAR a : Axis; END_VAR
lim := a.Limit;
a.Limit := a.Limit + 1;
END_FUNCTION_BLOCK
VAR x : Axis; y : Axis := (Speed := 3.0); c : Cell; cs : ARRAY [0..1] OF Cell; h : Holder;
  speed : REAL; lim : INT; ys : REAL; yl : INT; cb : INT; ca : INT; arr : INT; csl : INT; hl : INT;
END_VAR
speed := x.Speed; lim := x.Limit; ys := y.Speed; yl := y.Limit;
cb := c.B.Limit; ca := c.A.Limit; arr := c.Arr[2].Limit; csl := cs[1].B.Limit;
h(); hl := h.lim;`,
        steps: [
          { expect: { speed: 1.5, lim: 100, ys: 3, yl: 100, cb: 100, ca: 100, arr: 100, csl: 100, hl: 100 } },
          { expect: { hl: 101 } },
        ],
      },
      {
        name: 'a struct field of a struct type takes a (field := ...) default, its own fields filling the rest',
        src: `TYPE Axis : STRUCT Speed : REAL := 1.5; Limit : INT := 100; END_STRUCT END_TYPE
TYPE Cell : STRUCT A : Axis; B : Axis := (Limit := 7); END_STRUCT END_TYPE
VAR c : Cell; d : Cell := (B := (Speed := 2.0)); cb : INT; ca : INT; bs : REAL; db : INT; ds : REAL; END_VAR
cb := c.B.Limit; ca := c.A.Limit; bs := c.B.Speed; db := d.B.Limit; ds := d.B.Speed;`,
        // d.B names only Speed: its Limit is Cell's default for B (7), over Axis's own (100)
        steps: [{ expect: { cb: 7, ca: 100, bs: 1.5, db: 7, ds: 2 } }],
        oracle: {
          skip: 'MATIEC refuses a NESTED (field := ...) value of a struct type that declares field defaults ("Initialization element identifier (Limit) is not declared in referenced structure/FB scope"), while it builds the same value for a struct without defaults and a top-level one for a struct with them: a gap in its type resolution, not a reading of the standard. vendorSyntax.test.ts holds the semantics on both engines',
        },
      },
      {
        name: 'an enumeration member written Mode.Idle, and an argument given nothing',
        src: `TYPE Mode : (Idle, Run, Stop) END_TYPE
VAR m : Mode := Mode.Run; t : TON; out : INT; et : TIME; isRun : BOOL; END_VAR
CASE m OF
  Mode.Idle: out := 1;
  Mode.Run, Mode.Stop: out := 2;
END_CASE
isRun := m = Mode.Run;
t(IN := TRUE, PT := T#1s, Q => , ET => et);`,
        steps: [{ expect: { out: 2, isRun: true } }],
      },
      {
        name: 'standard blocks and a variable linked at %I*',
        src: `TYPE Io : STRUCT bIn AT %I* : BOOL; nOut AT %QW* : INT; END_STRUCT END_TYPE
FUNCTION_BLOCK Cyl
VAR bExtended AT %I* : BOOL; END_VAR
VAR_OUTPUT q : BOOL; END_VAR
q := NOT bExtended;
END_FUNCTION_BLOCK
VAR pins : Io; c : Cyl; t : TON; edge : R_TRIG; start AT %I* : BOOL; out : INT; q : BOOL; run : BOOL; s : STRING; END_VAR
pins.nOut := 5; out := pins.nOut;
c(); edge(CLK := c.q);
run := run OR edge.Q;
t(IN := run, PT := T#200ms);
q := t.Q;
s := CONCAT('a', 'b');`,
        steps: [{ expect: { out: 5, q: false, s: 'ab' } }, { expect: { q: false } }, { expect: { q: true } }],
      },
      {
        name: 'an enumeration with a base type, (Idle, Run) UINT',
        // (no explicit values: IEC's 2nd edition, so MATIEC, has none, measured on the Mode.Idle case above)
        src: `TYPE Mode :
(
  Idle,
  Run,
  Stop
) UINT;
END_TYPE
VAR m : Mode := Mode.Stop; isStop : BOOL; END_VAR
isStop := m = Mode.Stop;
IF isStop THEN m := Mode.Run; END_IF`,
        steps: [{ expect: { isStop: true } }, { expect: { isStop: false } }],
      },
      {
        name: 'an enumeration in a declaration',
        src: `FUNCTION_BLOCK Seq
VAR state : (Waiting, Going, Finished); END_VAR
VAR_OUTPUT atEnd : BOOL; END_VAR
CASE state OF
  Waiting: state := Going;
  Going: state := Finished;
  Finished: atEnd := TRUE;
END_CASE;
END_FUNCTION_BLOCK
VAR s : Seq; fin : BOOL; END_VAR
s(); fin := s.atEnd;`,
        steps: [{ expect: { fin: false } }, { expect: { fin: false } }, { expect: { fin: true } }],
        oracle: {
          skip: 'IEC (enumerated_spec_init), but MATIEC parses it and then cannot generate it: "C code generator does not currently support anonymous enumerated data types" (generate_c_base.cc). A gap of that compiler, not a reading of the standard',
        },
      },
      {
        name: 'a STRING capacity written as a constant',
        src: `VAR_GLOBAL CONSTANT MAX_LEN : INT := 5; END_VAR
TYPE ST_B : STRUCT y : INT := 2; text : STRING(MAX_LEN); END_STRUCT; END_TYPE
VAR b : ST_B; n : INT; l : INT; END_VAR
b.text := 'abcdefgh';
n := b.y; l := LEN(b.text);`,
        steps: [{ expect: { n: 2, l: 5 } }],
        oracle: {
          skip: 'IEC writes a STRING capacity as an integer, never a constant expression: an input form the engine reads. The export (export.ts `foldedCapacities`) writes the folded integer, but the oracle renders the text target directly, which cannot fold it',
        },
      },
      {
        name: 'an interface base in the __SYSTEM namespace, and PUBLIC on a signature, read as saying nothing',
        src: `INTERFACE ICount EXTENDS __SYSTEM.IQueryInterface
METHOD PUBLIC Bump : INT
VAR_INPUT step : INT; END_VAR
END_METHOD
END_INTERFACE
FUNCTION_BLOCK Counter IMPLEMENTS ICount
VAR n : INT; END_VAR
METHOD PUBLIC Bump : INT
VAR_INPUT step : INT; END_VAR
n := n + step;
Bump := n;
END_METHOD
END_FUNCTION_BLOCK
VAR c : Counter; got : INT; END_VAR
got := c.Bump(step := 2);`,
        steps: [{ expect: { got: 2 } }, { expect: { got: 4 } }],
        oracle: { editionReject: OOP_EDITION },
      },
    ],
  },
]

/** Every case, flattened - the order the oracle replays them in. */
export const CONFORMANCE_CASES: Case[] = CONFORMANCE_GROUPS.flatMap((g) => g.cases)
