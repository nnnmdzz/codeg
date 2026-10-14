import { beforeEach, describe, expect, it } from "vitest"

import {
  addPersonalRule,
  personalSetting,
  previewSetting,
  recordPick,
  removePersonalRule,
  resetZhTwSettingsCache,
  styleSetting,
} from "./settings"

beforeEach(() => {
  localStorage.clear()
  resetZhTwSettingsCache()
})

describe("zh-tw settings", () => {
  it("defaults to everyday wording with the preview on and no personal words", () => {
    expect(styleSetting.get()).toBe("everyday")
    expect(previewSetting.get()).toBe(true)
    expect(personalSetting.get().size).toBe(0)
  })

  it("remembers changes on this device", () => {
    styleSetting.set("formal")
    previewSetting.set(false)
    addPersonalRule("项目", "項目")
    resetZhTwSettingsCache()
    expect(styleSetting.get()).toBe("formal")
    expect(previewSetting.get()).toBe(false)
    expect([...personalSetting.get()]).toEqual([["项目", "項目"]])

    styleSetting.set("everyday")
    previewSetting.set(true)
    removePersonalRule("项目")
    expect(localStorage.length).toBe(0)
  })

  it("ignores stored data it cannot read", () => {
    localStorage.setItem("codeg_fork_zh_tw_personal", "{not json")
    localStorage.setItem("codeg_fork_zh_tw_style", "fancy")
    expect(personalSetting.get().size).toBe(0)
    expect(styleSetting.get()).toBe("everyday")

    localStorage.setItem(
      "codeg_fork_zh_tw_personal",
      JSON.stringify([["原生态", "道地"], ["", "空的"], [1, 2], "x"])
    )
    resetZhTwSettingsCache()
    expect([...personalSetting.get()]).toEqual([["原生态", "道地"]])
  })

  it("keeps the same dictionary object until it changes", () => {
    const first = personalSetting.get()
    expect(personalSetting.get()).toBe(first)
    addPersonalRule("原生态", "道地")
    expect(personalSetting.get()).not.toBe(first)
  })

  it("counts how often a wording was picked for the same original", () => {
    expect(recordPick("项目", "項目")).toBe(1)
    expect(recordPick("项目", "項目")).toBe(2)
    expect(recordPick("项目", "計畫")).toBe(1)
    expect(recordPick("类型", "型別")).toBe(1)
  })
})
