document.getElementById("entry").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const res = await fetch("/api/profile", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-material-client": "hub",
      },
      body: JSON.stringify({ id: document.getElementById("identity").value }),
    });
    if (!res.ok) throw Error((await res.json()).error || "切换身份失败");
    location.replace("/");
  } catch (err) {
    document.getElementById("message").textContent = err.message;
  }
});
