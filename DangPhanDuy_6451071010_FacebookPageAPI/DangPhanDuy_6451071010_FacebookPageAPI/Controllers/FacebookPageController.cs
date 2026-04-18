using Models;
using Services;
using Microsoft.AspNetCore.Mvc;

namespace Controllers;

[ApiController]
[Route("api/page")]
public class PageController : ControllerBase
{
    private readonly FacebookPageService _facebookPageService;

    public PageController(FacebookPageService facebookPageService)
    {
        _facebookPageService = facebookPageService;
    }

    [HttpGet("{pageId}")]
    public async Task<IActionResult> GetPageInfo(string pageId)
    {
        var result = await _facebookPageService.GetPageInfoAsync(pageId);
        return Content(result, "application/json");
    }

    [HttpGet("{pageId}/posts")]
    public async Task<IActionResult> GetPagePosts(string pageId)
    {
        var result = await _facebookPageService.GetPagePostAsync(pageId);
        return Content(result, "application/json");
    }

    [HttpPost("{pageId}/posts")]
    public async Task<IActionResult> CreatePost(string pageId, [FromBody] CreatePostRequest request)
    {
        var result = await _facebookPageService.CreatePostAsync(pageId, request.Message);
        return Content(result, "application/json");
    }

    [HttpDelete("post/{postId}")]
    public async Task<IActionResult> DeletePost(string postId)
    {
        var result = await _facebookPageService.DeletePostAsync(postId);
        return Content(result, "application/json");
    }

    [HttpGet("post/{postId}/comments")]
    public async Task<IActionResult> GetPostComments(string postId)
    {
        var result = await _facebookPageService.GetPostCommentsAsync(postId);
        return Content(result, "application/json");
    }

    [HttpGet("post/{postId}/likes")]
    public async Task<IActionResult> GetPostLikes(string postId)
    {
        var result = await _facebookPageService.GetPostLikesAsync(postId);
        return Content(result, "application/json");
    }

    [HttpGet("{pageId}/insights")]
    public async Task<IActionResult> GetPageInsights(string pageId)
    {
        var result = await _facebookPageService.GetPageInsightsAsync(pageId);
        return Content(result, "application/json");
    }
}