// ローディング
window.onload = () => {
  document.getElementById("loader").style.display = "none";
};


function toggleMenu(){
  const nav = document.querySelector(".top-nav");
  nav.classList.toggle("active");
}
