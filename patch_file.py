import re
import fs

def patch_file(path):
    with open(path, 'r') as f:
        content = f.read()

    # 1. Main wrapper of Image Tab -> h-full (not h-screen) so it relies on home wrapper.
    content = content.replace(
        '<div className="w-full h-screen overflow-hidden flex flex-col bg-slate-100">',
        '<div className="w-full h-full overflow-hidden flex flex-col bg-slate-100">'
    )

    # 2. Header Stepper compression -> Slim height
    old_stepper = """            <div className="w-full border-b border-slate-200 bg-white px-5 py-2">
              <div className="flex items-center gap-3 text-sm font-medium">
                <div className="rounded-full bg-emerald-100 px-3 py-1 text-emerald-700">1. Upload</div>
                <div className="h-px flex-1 bg-slate-200" />
                <div className="rounded-full bg-action-100 px-3 py-1 text-action-700">2. Image Preparation</div>
                <div className="h-px flex-1 bg-slate-200" />
                <div className="rounded-full bg-slate-100 px-3 py-1 text-slate-500">3. Enhance</div>
              </div>
            </div>"""
    new_stepper = """            <div className="w-full border-b border-slate-200 bg-white px-4 py-1 shrink-0">
              <div className="flex items-center justify-center gap-2 text-xs font-medium max-w-lg mx-auto">
                <div className="text-emerald-700 flex items-center gap-1"><span className="w-4 h-4 rounded-full bg-emerald-100 flex items-center justify-center">1</span> Upload</div>
                <div className="h-0.5 w-8 bg-slate-200 mx-2" />
                <div className="text-action-700 flex items-center gap-1 font-bold"><span className="w-4 h-4 rounded-full bg-action-100 flex items-center justify-center text-[10px]">2</span> Image Preparation</div>
                <div className="h-0.5 w-8 bg-slate-200 mx-2" />
                <div className="text-slate-500 flex items-center gap-1"><span className="w-4 h-4 rounded-full bg-slate-100 flex items-center justify-center text-[10px]">3</span> Enhance</div>
              </div>
            </div>"""
    content = content.replace(old_stepper, new_stepper)
    
    # 3. Sidebar Alignment and space-y-2
    content = content.replace(
        '<aside className="w-80 h-full overflow-hidden bg-white border-r border-slate-200 p-3">',
        '<aside className="w-80 h-full flex flex-col overflow-hidden bg-white border-r border-slate-200 p-3">'
    )
    # The div space-y-4 right after aside
    content = content.replace(
        '<aside className="w-80 h-full flex flex-col overflow-hidden bg-white border-r border-slate-200 p-3">\n                  <div className="space-y-4">',
        '<aside className="w-80 h-full flex flex-col overflow-hidden bg-white border-r border-slate-200 p-3">\n                  <div className="space-y-2 flex-1 overflow-y-auto pr-1">'
    )

    # 4. Canvas Padding removed from containers
    # The div after aside
    content = content.replace(
        '<div className="flex-1 h-full min-h-0 px-5 pt-3 pb-20 bg-slate-50 flex flex-col overflow-hidden">',
        '<div className="flex-1 h-full min-h-0 px-5 bg-slate-50 flex flex-col overflow-hidden justify-between">'
    )

    # Inner flex-1
    content = content.replace(
        '<div className="flex-1 flex flex-col justify-center items-center min-h-0 py-2">',
        '<div className="flex-1 flex flex-col justify-center items-center min-h-0 min-w-0 w-full">'
    )
    
    # Header image wrapper
    content = content.replace(
        '<div className="flex items-center justify-between gap-3">',
        '<div className="flex items-center justify-between gap-3 shrink-0 py-1.5">'
    )
    
    content = content.replace(
        '<div className="flex items-center justify-between gap-3 shrink-0 py-1.5">\n                    <div className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-700">',
        '<div className="flex items-center justify-between gap-3 shrink-0 py-1.5">\n                    <div className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-700 shadow-sm z-10">'
    )

    # Hero image
    content = content.replace(
        '<div className="relative h-full max-h-[52vh] w-full rounded-2xl overflow-hidden bg-white border border-slate-200 shadow-sm">',
        '<div className="relative h-full w-full max-h-[50vh] rounded-2xl overflow-hidden bg-white border border-slate-200 shadow-sm flex items-center justify-center shrink-0">'
    )

    content = content.replace(
        'className="h-full w-full object-contain rounded-2xl"',
        'className="h-full w-full object-contain rounded-2xl p-0.5"'
    )

    # 5. Exterior and Interior Buttons max length
    old_ext_btn = 'className={`px-4 py-1.5 rounded-lg border text-sm font-medium ${sceneType === "exterior" ? "border-green-500 bg-green-50" : "border-slate-300 bg-white"}`}'
    new_ext_btn = 'className={`px-12 py-1.5 rounded-lg border text-sm font-medium min-w-[140px] ${sceneType === "exterior" ? "border-green-500 bg-green-50 shadow-sm" : "border-slate-300 bg-white hover:bg-slate-50"}`}'
    content = content.replace(old_ext_btn, new_ext_btn)
    
    old_int_btn = 'className={`px-4 py-1.5 rounded-lg border text-sm font-medium ${sceneType === "interior" ? "border-green-500 bg-green-50" : "border-slate-300 bg-white"}`}'
    new_int_btn = 'className={`px-12 py-1.5 rounded-lg border text-sm font-medium min-w-[140px] ${sceneType === "interior" ? "border-green-500 bg-green-50 shadow-sm" : "border-slate-300 bg-white hover:bg-slate-50"}`}'
    content = content.replace(old_int_btn, new_int_btn)
    
    # 6. Thumbnail carousel height
    content = content.replace(
        'className="h-16 w-24 object-cover"',
        'className="h-20 w-28 object-cover"'
    )
    
    # 7. Fixed footer
    old_footer = '            {files.length > 0 && (\n              <div className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-200 bg-white p-3 flex items-center justify-end gap-3">'
    new_footer = '            {files.length > 0 && (\n              <footer className="h-16 shrink-0 flex items-center justify-end px-6 border-t border-slate-200 bg-white z-40 gap-3 w-full shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.05)]">'
    content = content.replace(old_footer, new_footer)

    # Change the Start Enhancement button inside footer
    old_start_btn = 'className="rounded-lg bg-action-600 px-6 py-2.5 font-medium text-white shadow-md transition-all hover:bg-action-700 hover:shadow-lg focus:ring-2 focus:ring-action-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"'
    new_start_btn = 'className="rounded-lg bg-gradient-to-r from-action-600 to-indigo-600 px-8 py-2 font-semibold text-white shadow-md transition-all hover:from-action-700 hover:to-indigo-700 hover:shadow-lg focus:ring-2 focus:ring-action-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 text-base md:text-lg flex items-center border border-transparent"'
    
    if old_start_btn in content:
        content = content.replace(old_start_btn, new_start_btn)
    
    with open(path, 'w') as f:
        f.write(content)
        
patch_file('/workspaces/RealEnhance-v2/client/src/components/batch-processor.tsx')

