// The xacro expander (core/xacro.ts) and its expressions (core/xacroExpr.ts), on a made-up two-package description that
// uses what vendor descriptions use: arguments that pick a model's YAML files, macros with defaults, blocks and `^`,
// includes through $(find), conditions, and Python in ${...}.
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { expandXacro, isXacroEntry, isXacroText, xacroArgChoices, XacroError, XACRO_YAML_TAGS, xacroSwitches, type XacroFiles } from './xacro'
import { evalXacroExpr, type XacroValue } from './xacroExpr'
import { parseUrdfRoot } from './urdf'
import { urdfToRig } from './urdfRig'
import { xmlKids } from './xml'

const ROBOT = `<?xml version="1.0"?>
<robot xmlns:xacro="http://wiki.ros.org/xacro" name="$(arg name)">
  <xacro:arg name="name" default="bot"/>
  <xacro:arg name="model" default="none"/>
  <xacro:arg name="hand" default="false"/>
  <xacro:include filename="$(find bot_parts)/urdf/arm_macro.xacro"/>
  <link name="world"/>
  <xacro:bot_arm prefix="" parent="world" config="$(find bot_description)/config/$(arg model)/kinematics.yaml">
    <origin xyz="0 0 0.5" rpy="0 0 0"/>
  </xacro:bot_arm>
  <xacro:if value="$(arg hand)">
    <link name="hand"/>
  </xacro:if>
</robot>`

const MACRO = `<?xml version="1.0"?>
<robot xmlns:xacro="http://wiki.ros.org/xacro">
  <xacro:include filename="common.xacro"/>
  <xacro:macro name="bot_arm" params="prefix parent config *origin color:=^|grey">
    <xacro:property name="k" value="\${xacro.load_yaml(config)['kinematics']}"/>
    <xacro:property name="reach" value="\${k['upper'] + k.fore}" scope="parent"/>
    <joint name="\${prefix}mount" type="fixed">
      <parent link="\${parent}"/><child link="\${prefix}base"/>
      <xacro:insert_block name="origin"/>
    </joint>
    <link name="\${prefix}base"><visual><geometry><box size="0.2 0.2 \${base_height}"/></geometry><material name="\${color}"/></visual></link>
    <xacro:segment name="\${prefix}upper" parent="\${prefix}base" length="\${k['upper']}" axis="0 1 0"/>
    <xacro:segment name="\${prefix}fore" parent="\${prefix}upper" length="\${k.fore}" axis="0 1 0" limit="\${pi/2 if k.fore &gt; 0.3 else pi}"/>
    <xacro:unless value="\${'tool' in k}">
      <link name="\${prefix}tool0"/>
      <joint name="\${prefix}flange" type="fixed"><parent link="\${prefix}fore"/><child link="\${prefix}tool0"/><origin xyz="\${k.fore} 0 0"/></joint>
    </xacro:unless>
  </xacro:macro>
</robot>`

const COMMON = `<?xml version="1.0"?>
<robot xmlns:xacro="http://wiki.ros.org/xacro">
  <xacro:property name="base_height" value="0.1"/>
  <xacro:property name="base_height" default="9"/>
  <xacro:macro name="segment" params="name parent length axis limit:=\${pi}">
    <link name="\${name}"/>
    <joint name="\${name}_joint" type="revolute">
      <parent link="\${parent}"/><child link="\${name}"/>
      <origin xyz="\${length} 0 0"/><axis xyz="\${axis}"/>
      <limit lower="\${-limit}" upper="\${limit}" effort="1" velocity="1"/>
    </joint>
  </xacro:macro>
</robot>`

const FILES: Record<string, string> = {
  'ws/bot_description/package.xml': '<package><name>bot_description</name></package>',
  'ws/bot_description/urdf/bot.urdf.xacro': ROBOT,
  'ws/bot_description/config/b1/kinematics.yaml': 'kinematics:\n  upper: 0.4\n  fore: 0.35\n',
  'ws/bot_description/config/b2/kinematics.yaml': 'kinematics:\n  upper: 0.6\n  fore: 0.25\n',
  'ws/parts/package.xml': '<package><name>bot_parts</name></package>',
  'ws/parts/urdf/arm_macro.xacro': MACRO,
  'ws/parts/urdf/common.xacro': COMMON,
}
const files: XacroFiles = { paths: Object.keys(FILES), read: (p) => FILES[p], parseYaml: (t) => parseYaml(t) as unknown }
const ROOT = 'ws/bot_description/urdf/bot.urdf.xacro'

const attr = (n: ReturnType<typeof expandXacro>['robot'], tag: string, name: string) => xmlKids(n, tag).find((c) => c.attrs.name === name)

describe('expandXacro', () => {
  it('expands a description into URDF with the model an argument picks', () => {
    const { robot, args } = expandXacro(ROOT, files, { model: 'b1' })
    expect(robot.attrs.name).toBe('bot')
    expect(args).toEqual({ name: 'bot', model: 'b1', hand: 'false' })
    expect(xmlKids(robot, 'link').map((l) => l.attrs.name)).toEqual(['world', 'base', 'upper', 'fore', 'tool0'])
    // a *block is inserted where the macro says; the property default did not replace the value set before it
    const mount = attr(robot, 'joint', 'mount')!
    expect(xmlKids(mount, 'origin')[0]!.attrs.xyz).toBe('0 0 0.5')
    expect(xmlKids(xmlKids(xmlKids(attr(robot, 'link', 'base')!, 'visual')[0], 'geometry')[0], 'box')[0]!.attrs.size).toBe('0.2 0.2 0.1')
    // a ^ parameter with no caller property takes its default
    expect(xmlKids(xmlKids(attr(robot, 'link', 'base')!, 'visual')[0], 'material')[0]!.attrs.name).toBe('grey')
    // YAML read through load_yaml, by key and as an attribute; a conditional default from Python's `a if c else b`
    const fore = attr(robot, 'joint', 'fore_joint')!
    expect(xmlKids(fore, 'origin')[0]!.attrs.xyz).toBe('0.35 0 0')
    expect(Number(xmlKids(fore, 'limit')[0]!.attrs.upper)).toBeCloseTo(Math.PI / 2, 12)
    expect(Number(xmlKids(attr(robot, 'joint', 'upper_joint')!, 'limit')[0]!.attrs.lower)).toBeCloseTo(-Math.PI, 12)
  })

  it('reads as a robot', () => {
    const urdf = parseUrdfRoot(expandXacro(ROOT, files, { model: 'b2', hand: 'true' }).robot)
    expect(urdf.links.map((l) => l.name)).toContain('hand')
    const rig = urdfToRig(urdf, { drawn: new Set() })
    expect(rig.robot?.joints).toEqual(['upper_joint', 'fore_joint'])
  })

  it('says which models an argument can name when its default names none', () => {
    let error: unknown
    try {
      expandXacro(ROOT, files)
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(XacroError)
    expect((error as XacroError).code).toBe('missing-file')
    expect(xacroArgChoices(error as XacroError, files.paths)).toEqual({ arg: 'model', value: 'none', choices: ['b1', 'b2'] })
  })

  it('refuses what it cannot read, with the reason', () => {
    const one = (text: string, extra: Record<string, string> = {}) => {
      const f: XacroFiles = { paths: ['r.xacro', ...Object.keys(extra)], read: (p) => (p === 'r.xacro' ? text : extra[p]), parseYaml }
      try {
        expandXacro('r.xacro', f)
        return null
      } catch (e) {
        return [(e as XacroError).code, (e as Error).message]
      }
    }
    const X = (body: string) => `<robot xmlns:xacro="x">${body}</robot>`
    expect(one(X('<xacro:include filename="$(find nowhere)/a.xacro"/>'))).toEqual(['missing-package', expect.stringMatching(/nowhere/)])
    expect(one(X('<xacro:nope/>'))).toEqual(['macro', 'no macro named nope'])
    expect(one(X('<xacro:macro name="m" params="a"/><xacro:m/>'))).toEqual(['macro', 'm needs a'])
    expect(one(X('<link name="${undefined_thing}"/>'))).toEqual(['expression', expect.stringMatching(/'undefined_thing' is not defined/)])
    expect(one(X('<link name="$(env HOME)"/>'))).toEqual(['unsupported', expect.stringMatching(/\$\(env\)/)])
    expect(one(X('<xacro:macro name="m" params=""><xacro:m/></xacro:macro><xacro:m/>'))).toEqual(['macro', expect.stringMatching(/nests more than/)])
    expect(one(X('<xacro:if value="maybe"><link name="a"/></xacro:if>'))).toEqual(['expression', expect.stringMatching(/true or false/)])
  })

  it('offers the on/off arguments that change the robot, and not those that change only what ROS reads', () => {
    const text =
      '<robot xmlns:xacro="x" name="s"><xacro:arg name="hand" default="false"/><xacro:arg name="sim" default="true"/>' +
      '<xacro:arg name="broken" default="false"/><xacro:arg name="speed" default="0"/><link name="base"/>' +
      '<xacro:if value="$(arg hand)"><link name="hand"/><joint name="hand_joint" type="fixed"><parent link="base"/><child link="hand"/></joint></xacro:if>' +
      '<xacro:if value="$(arg sim)"><gazebo/></xacro:if>' +
      '<xacro:if value="$(arg broken)"><xacro:include filename="gone.xacro"/></xacro:if></robot>'
    const f: XacroFiles = { paths: ['s.xacro'], read: (p) => (p === 's.xacro' ? text : undefined), parseYaml }
    const r = expandXacro('s.xacro', f)
    expect(r.args).toEqual({ hand: 'false', sim: 'true', broken: 'false', speed: '0' })
    expect(xacroSwitches('s.xacro', f, r)).toEqual({ hand: false })
    expect(xacroSwitches('s.xacro', f, expandXacro('s.xacro', f, { hand: 'true' }))).toEqual({ hand: true })
  })

  it('reads YAML angles in degrees as radians, as xacro does', () => {
    const text = `<robot xmlns:xacro="x" name="d"><xacro:property name="l" value="\${xacro.load_yaml('l.yaml')}"/>` +
      `<link name="a"/><link name="b"/><joint name="j" type="revolute"><parent link="a"/><child link="b"/>` +
      `<limit lower="\${l.lo}" upper="\${l.hi}"/></joint></robot>`
    const f: XacroFiles = {
      paths: ['d.xacro', 'l.yaml'],
      read: (p) => (p === 'd.xacro' ? text : 'lo: !degrees -90\nhi: !radians 1.5\n'),
      parseYaml: (t) => parseYaml(t, { customTags: XACRO_YAML_TAGS }) as unknown,
    }
    const limit = xmlKids(expandXacro('d.xacro', f).robot, 'joint')[0]!.children.find((c) => c.name === 'limit')!.attrs
    expect(Number(limit.lower)).toBeCloseTo(-Math.PI / 2, 12)
    expect(Number(limit.upper)).toBe(1.5)
  })

  it('tells a robot to import from a library of macros', () => {
    expect(isXacroEntry(FILES[ROOT]!)).toBe(true)
    expect(isXacroEntry(MACRO)).toBe(false)
    expect(isXacroEntry(COMMON)).toBe(false)
    expect(isXacroText(MACRO)).toBe(true)
    expect(isXacroText('<robot name="plain"><link name="a"/></robot>')).toBe(false)
  })
})

describe('xacro expressions', () => {
  const ev = (src: string, names: Record<string, XacroValue> = {}) => evalXacroExpr(src, (n) => names[n])
  it('reads the Python robot descriptions use', () => {
    expect(ev('1./12 * 3 * (3 * 2**2 + 1)')).toBeCloseTo(3.25, 12)
    expect(ev('7 // 2 + 7 % 3 - -1')).toBe(5)
    expect(ev("x[1] if 'b' in d else 0", { x: [5, 6], d: { b: 1 } })).toBe(6)
    expect(ev("d['a']['b'] + d.a.b", { d: { a: { b: 2 } } })).toBe(4)
    expect(ev("not s and n != ''", { s: '', n: 'x' })).toBe(true)
    expect(ev('1 < x <= 3', { x: 3 })).toBe(true)
    expect(ev("'AB'.lower() + 'x y'.split()[1]")).toBe('aby')
    expect(ev("'k' not in d", { d: {} })).toBe(true)
  })
  it('runs nothing it is not given', () => {
    expect(() => ev("__import__('os')")).toThrow(/not defined/)
    expect(() => ev('(1).constructor')).toThrow()
  })
})
